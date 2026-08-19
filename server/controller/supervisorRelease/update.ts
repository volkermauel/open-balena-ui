import { supervisorAppSlug } from './cloud';
import { NotFoundError } from './errors';
import {
  findAppReleases,
  findApplicationBySlug,
  getDeviceTypeBySlug,
  InstanceAuth,
  patchDeviceSupervisorRelease,
} from './instance';

/**
 * Set an already-imported supervisor version as the target supervisor release
 * of each device with the caller's JWT. Importing (mirroring image bytes into
 * the per-arch registry repo) happens exclusively on the arch-scoped Supervisor
 * Versions surface — this flow never mirrors, it only pins. The instance's
 * pine hooks enforce the no-downgrade rule per device; failures are collected
 * per device so bulk updates tolerate partial failure.
 */

export interface DeviceUpdateResult {
  id: number;
  ok: boolean;
  message?: string;
}

export interface BulkUpdateSummary {
  total: number;
  updated: number;
  rejected: number;
}

/** Aggregate per-device results into a summary. Pure — unit tested. */
export const aggregateResults = (results: DeviceUpdateResult[]): BulkUpdateSummary => {
  const updated = results.filter((result) => result.ok).length;
  return { total: results.length, updated, rejected: results.length - updated };
};

export interface SupervisorUpdateOutcome {
  releaseId: number;
  results: DeviceUpdateResult[];
}

export const updateSupervisorReleases = async (
  auth: InstanceAuth,
  deviceTypeSlug: string,
  version: string,
  deviceIds: number[],
): Promise<SupervisorUpdateOutcome> => {
  const { arch } = await getDeviceTypeBySlug(auth, deviceTypeSlug);
  const app = await findApplicationBySlug(auth, supervisorAppSlug(arch));
  const releases = app ? await findAppReleases(auth, app.id) : [];

  // The catalog stores semvers without the `v` prefix; releases may keep it in
  // their raw version — accept both spellings.
  const normalized = version.replace(/^v/, '');
  const release = releases.find(
    (candidate) =>
      candidate.semver === normalized ||
      candidate.rawVersion === normalized ||
      candidate.rawVersion === `v${normalized}`,
  );
  if (!release) {
    throw new NotFoundError(
      `Supervisor version ${version} is not imported for architecture ${arch}. ` +
        `Import it via 'Supervisor Versions' on the Device Types page first.`,
    );
  }

  const results: DeviceUpdateResult[] = [];
  for (const deviceId of deviceIds) {
    try {
      await patchDeviceSupervisorRelease(auth, deviceId, release.id);
      results.push({ id: deviceId, ok: true });
    } catch (error) {
      // e.g. the API's "Attempt to downgrade supervisor, which is not allowed"
      const message = error instanceof Error ? error.message : 'Supervisor update rejected';
      results.push({ id: deviceId, ok: false, message });
    }
  }

  return { releaseId: release.id, results };
};
