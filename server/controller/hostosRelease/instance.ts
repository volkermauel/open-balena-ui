import { createHash } from 'node:crypto';
import { InstanceApiError } from './errors';
import {
  InstanceAuth,
  odataGet,
  odataPatch,
  odataPost,
  releaseSupportsField,
  releaseVersionField,
  SemverFields,
} from '../supervisorRelease/instance';

/**
 * Instance (openBalena pine API) access specific to hostOS releases. Runs
 * with the caller's forwarded `Authorization` header, like the supervisor
 * feature's instance module; the generic lookups (application, release,
 * image, release_image) are reused from there.
 */

/** First service of an application (lowest id) — hostapp images attach to it. */
export const findAppService = async (auth: InstanceAuth, appId: number): Promise<{ id: number } | null> => {
  const rows = await odataGet<{ id: number }>(
    auth,
    `/v6/service?$select=id&$filter=application%20eq%20${appId}&$orderby=id%20asc&$top=1`,
  );
  return rows[0] ?? null;
};

/** Whether a release already carries a `version` tag with exactly this value. */
export const hasReleaseTag = async (
  auth: InstanceAuth,
  releaseId: number,
  tagKey: string,
  expectedValue: string,
): Promise<boolean> => {
  if (!/^[a-zA-Z0-9_.-]+$/.test(tagKey)) {
    throw new InstanceApiError(`Invalid release tag key: ${tagKey}`);
  }
  const rows = await odataGet<{ id: number; value?: string }>(
    auth,
    `/v6/release_tag?$select=id,value&$filter=release%20eq%20${releaseId}%20and%20tag_key%20eq%20'${tagKey}'&$top=1`,
  );
  return rows[0]?.value === expectedValue;
};

/**
 * Tag a release — the Target-OS selector lists hostapp releases by their
 * `version` release tag, and the instance API falls back to that tag when
 * comparing OS versions, so it is part of a complete import.
 */
export const createReleaseTag = async (
  auth: InstanceAuth,
  releaseId: number,
  tagKey: string,
  value: string,
): Promise<void> => {
  // Upsert: a tag row with the key may already exist with another value —
  // PATCH it instead of creating a duplicate (the selector picks data[0]).
  const existing = await odataGet<{ id: number }>(
    auth,
    `/v6/release_tag?$select=id&$filter=release%20eq%20${releaseId}%20and%20tag_key%20eq%20'${tagKey}'&$top=1`,
  );
  if (existing[0]) {
    await odataPatch(auth, `/v6/release_tag(${existing[0].id})`, { value });
    return;
  }
  await odataPost<{ id: number }>(auth, 'release_tag', {
    release: releaseId,
    tag_key: tagKey,
    value,
  });
};

/**
 * Deterministic commit for an imported hostOS release, derived from the
 * machine and mirrored tag (open-balena-api caps commit at 40 chars).
 * Pure — unit tested.
 */
export const hostosCommit = (machine: string, tag: string): string =>
  createHash('sha256').update(`${machine}:${tag}`).digest('hex').slice(0, 40);

export interface CreateHostosReleaseInput {
  appId: number;
  commit: string;
  /** ghcr tag verbatim (`7.4.0-rev5`) — kept as the release raw version. */
  rawVersion: string;
  /** Parsed balenaOS version (`7.4.0+rev5`) — source of the semver fields. */
  version: string;
  semver: SemverFields;
  composition: unknown;
}

/**
 * Create the hostapp release row (version-field tolerant).
 *
 * Newer instances derive the `semver_*` fields from a `semver` request field
 * and strip explicitly posted ones (release-versioning hook); final releases
 * additionally get a server-chosen revision that rejects `+revN` builds. Such
 * instances therefore get the parsed version as a draft release
 * (`is_final: false`) — the API explicitly supports draft hostapp releases
 * (device provisioning matches them with `revision: null`), and the
 * no-downgrade check then compares the real semver. Instances without
 * `is_final` support predate the hook, so the explicit fields pass through.
 */
export const createHostosRelease = async (
  auth: InstanceAuth,
  input: CreateHostosReleaseInput,
): Promise<{ id: number }> => {
  const versionField = await releaseVersionField(auth);
  const body: Record<string, unknown> = {
    belongs_to__application: input.appId,
    commit: input.commit,
    composition: input.composition,
    status: 'success',
    source: 'cloud',
    variant: '',
    start_timestamp: new Date().toISOString(),
    [versionField]: input.rawVersion,
  };

  if (await releaseSupportsField(auth, 'is_final')) {
    body.semver = input.version;
    body.is_final = false;
  } else {
    body.semver_major = input.semver.major;
    body.semver_minor = input.semver.minor;
    body.semver_patch = input.semver.patch;
    body.semver_prerelease = input.semver.prerelease;
    body.semver_build = input.semver.build;
  }

  return odataPost<{ id: number }>(auth, 'release', body);
};
