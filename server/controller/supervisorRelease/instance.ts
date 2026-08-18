import { createHash } from 'node:crypto';
import { InstanceApiError, NotFoundError } from './errors';
import { supervisorAppSlug } from './cloud';
import { SEMVER_PATTERN } from './semver';

/**
 * Reads/writes against the user's openBalena instance, always with the
 * caller's forwarded `Authorization` header. Endpoint paths mirror the
 * instance's v6 (pine) API — the same resource names the dataProvider uses
 * (`application`, `release`, `release_image`, `device`, …) — because writes
 * (e.g. the device supervisor-release PATCH) must run the instance's pine
 * hooks.
 */

export interface InstanceAuth {
  authorization: string;
}

export interface DeviceTypeInfo {
  id: number;
  slug: string;
  arch: string;
}

export interface InstanceRelease {
  id: number;
  rawVersion: string;
  semver: string | null;
}

export interface InstanceImage {
  id: number;
  serviceId: number;
  location: string;
  contentHash: string;
}

export interface CreateReleaseInput {
  appId: number;
  commit: string;
  rawVersion: string;
  semver: SemverFields;
  composition: unknown;
}

export interface SemverFields {
  major: number;
  minor: number;
  patch: number;
  prerelease: string;
  build: string;
}

export const instanceApiUrl = (): string => {
  const url = process.env.REACT_APP_OPEN_BALENA_API_URL;
  if (!url) {
    throw new InstanceApiError('REACT_APP_OPEN_BALENA_API_URL is not configured on the server', 500);
  }
  return url.replace(/\/+$/, '');
};

const asArray = <T>(value: T | T[] | null | undefined): T[] =>
  value == null ? [] : Array.isArray(value) ? value : [value];

const extractErrorMessage = async (res: Response, fallback: string): Promise<string> => {
  try {
    const body = (await res.json()) as unknown;
    if (body && typeof body === 'object') {
      const anyBody = body as Record<string, unknown>;
      // pine error shape: { error: { text } } / { message } / plain string bodies
      const error = anyBody.error;
      if (error && typeof error === 'object' && 'text' in error && typeof error.text === 'string') {
        return error.text;
      }
      if (typeof anyBody.message === 'string') {
        return anyBody.message;
      }
      if (typeof error === 'string') {
        return error;
      }
    }
    if (typeof body === 'string') {
      return body.slice(0, 300);
    }
  } catch {
    // fall through to the fallback
  }
  return fallback;
};

const instanceFetch = async (auth: InstanceAuth, path: string, init?: RequestInit): Promise<Response> => {
  const res = await fetch(`${instanceApiUrl()}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers as Record<string, string> | undefined),
      Authorization: auth.authorization,
    },
  });
  return res;
};

export const odataGet = async <T>(auth: InstanceAuth, path: string): Promise<T[]> => {
  const res = await instanceFetch(auth, path);
  if (!res.ok) {
    throw new InstanceApiError(await extractErrorMessage(res, `Instance request failed (${res.status})`));
  }
  const body = (await res.json()) as { d?: T[] } | T[];
  return Array.isArray(body) ? body : (body.d ?? []);
};

export const odataPost = async <T extends { id: number }>(
  auth: InstanceAuth,
  resource: string,
  data: Record<string, unknown>,
): Promise<T> => {
  const res = await instanceFetch(auth, `/v6/${resource}`, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    throw new InstanceApiError(await extractErrorMessage(res, `Instance create of ${resource} failed (${res.status})`));
  }
  const body: unknown = await res.json();
  if (Array.isArray(body)) {
    const rows = (body as { d?: T[] }).d ?? [];
    if (!rows[0]) {
      throw new InstanceApiError(`Instance create of ${resource} returned no row`);
    }
    return rows[0];
  }
  return body as T;
};

export const odataPatch = async (auth: InstanceAuth, path: string, data: Record<string, unknown>): Promise<Response> =>
  instanceFetch(auth, path, { method: 'PATCH', body: JSON.stringify(data) });

// ---------------------------------------------------------------------------
// Field-name compatibility probes (cache per process)
// ---------------------------------------------------------------------------

const releaseFieldCache = new Map<string, boolean>();

/**
 * Probe whether the instance's release resource supports a field (e.g.
 * `raw_version` vs the newer `release_version`, `is_final`). Uses a $select on
 * the resource: unknown fields are rejected with 400 regardless of row count.
 */
export const releaseSupportsField = async (auth: InstanceAuth, field: string): Promise<boolean> => {
  const cached = releaseFieldCache.get(field);
  if (cached !== undefined) {
    return cached;
  }

  const res = await instanceFetch(auth, `/v6/release?$select=${field}&$top=1`);
  const supported = res.ok;
  releaseFieldCache.set(field, supported);
  return supported;
};

/** The instance's name for the raw version column of `release`. */
export const releaseVersionField = async (auth: InstanceAuth): Promise<'raw_version' | 'release_version'> =>
  (await releaseSupportsField(auth, 'raw_version')) ? 'raw_version' : 'release_version';

// ---------------------------------------------------------------------------
// Device type / arch resolution
// ---------------------------------------------------------------------------

/** Resolve a device type slug to its id and CPU arch slug via the instance. */
export const getDeviceTypeBySlug = async (auth: InstanceAuth, slug: string): Promise<DeviceTypeInfo> => {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new NotFoundError(`Invalid device type slug: ${slug}`);
  }

  interface Row {
    id: number;
    slug: string;
    is_of__cpu_architecture?: { slug?: string }[] | { slug?: string } | null;
  }

  const rows = await odataGet<Row>(
    auth,
    `/v6/device_type?$filter=slug%20eq%20'${slug}'&$select=id,slug&$expand=is_of__cpu_architecture($select=slug)`,
  );
  const row = rows[0];
  if (!row) {
    throw new NotFoundError(`Unknown device type: ${slug}`);
  }

  const arch = asArray(row.is_of__cpu_architecture)[0]?.slug;
  if (!arch) {
    throw new InstanceApiError(`Device type ${slug} has no CPU architecture on the instance`);
  }

  return { id: row.id, slug: row.slug, arch };
};

/** Find any instance device type for a CPU arch slug (first by id) — used for app creation. */
export const findDeviceTypeByArch = async (auth: InstanceAuth, arch: string): Promise<DeviceTypeInfo> => {
  interface Row {
    id: number;
    slug: string;
    is_of__cpu_architecture?: { slug?: string }[] | { slug?: string } | null;
  }

  const rows = await odataGet<Row>(
    auth,
    `/v6/device_type?$select=id,slug,is_of__cpu_architecture&$expand=is_of__cpu_architecture($select=slug)` +
      `&$orderby=id%20asc&$top=1000`,
  );

  const match = rows.find((row) => asArray(row.is_of__cpu_architecture)[0]?.slug === arch);
  if (!match) {
    throw new NotFoundError(`The instance has no device type for CPU architecture ${arch}`);
  }

  return { id: match.id, slug: match.slug, arch };
};

// ---------------------------------------------------------------------------
// Supervisor application / services / images / releases
// ---------------------------------------------------------------------------

/** Look up an existing supervisor application by its exact slug. */
export const findApplicationBySlug = async (auth: InstanceAuth, slug: string): Promise<{ id: number } | null> => {
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_/-]*$/.test(slug)) {
    throw new InstanceApiError(`Invalid application slug: ${slug}`);
  }
  const rows = await odataGet<{ id: number }>(auth, `/v6/application?$select=id&$filter=slug%20eq%20'${slug}'&$top=1`);
  return rows[0] ?? null;
};

/** All releases of an application (id, raw version, semver). */
export const findAppReleases = async (auth: InstanceAuth, appId: number): Promise<InstanceRelease[]> => {
  const versionField = await releaseVersionField(auth);
  const rows = await odataGet<{ id: number; raw_version?: string; release_version?: string; semver?: string }>(
    auth,
    `/v6/release?$select=id,${versionField},semver&$filter=belongs_to__application%20eq%20${appId}` +
      `&$orderby=id%20desc&$top=1000`,
  );

  return rows.map((row) => ({
    id: row.id,
    rawVersion: (versionField === 'raw_version' ? row.raw_version : row.release_version) ?? '',
    semver: row.semver ?? null,
  }));
};

/** Look up a service of an application by name. */
export const findServiceByName = async (
  auth: InstanceAuth,
  appId: number,
  serviceName: string,
): Promise<{ id: number } | null> => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(serviceName)) {
    throw new InstanceApiError(`Invalid service name: ${serviceName}`);
  }
  const rows = await odataGet<{ id: number }>(
    auth,
    `/v6/service?$select=id&$filter=application%20eq%20${appId}%20and%20service_name%20eq%20'${serviceName}'&$top=1`,
  );
  return rows[0] ?? null;
};

/** Look up an image by content hash (globally unique per registry digest). */
export const findImageByContentHash = async (
  auth: InstanceAuth,
  contentHash: string,
): Promise<InstanceImage | null> => {
  if (!/^sha256:[a-f0-9]{64}$/.test(contentHash)) {
    throw new InstanceApiError(`Invalid content hash: ${contentHash}`);
  }
  const rows = await odataGet<{
    id: number;
    is_a_build_of__service?: { __id?: number } | { __id?: number }[] | number | null;
    is_stored_at__image_location?: string;
    content_hash?: string;
  }>(
    auth,
    `/v6/image?$select=id,is_a_build_of__service,is_stored_at__image_location,content_hash` +
      `&$filter=content_hash%20eq%20'${contentHash}'&$top=1`,
  );

  const row = rows[0];
  if (!row) {
    return null;
  }

  const service = asArray(row.is_a_build_of__service)[0];
  const serviceId =
    service && typeof service === 'object' && '__id' in service
      ? (service.__id as number)
      : typeof service === 'number'
        ? service
        : 0;

  return {
    id: row.id,
    serviceId,
    location: row.is_stored_at__image_location ?? '',
    contentHash: row.content_hash ?? contentHash,
  };
};

/** Look up release↔image links of a release. */
export const findReleaseImages = async (auth: InstanceAuth, releaseId: number): Promise<{ imageId: number }[]> => {
  const rows = await odataGet<{ image: { __id?: number } | { __id?: number }[] | number }>(
    auth,
    `/v6/release_image?$select=image&$filter=release%20eq%20${releaseId}&$top=1000`,
  );

  return rows
    .map((row) => {
      const image = asArray(row.image)[0];
      if (image && typeof image === 'object' && '__id' in image) {
        return { imageId: image.__id as number };
      }
      return typeof image === 'number' ? { imageId: image } : null;
    })
    .filter((entry): entry is { imageId: number } => entry !== null);
};

/** Parse a semver string into the release row's semver_* fields. Pure — unit tested. */
export const parseSemverFields = (version: string): SemverFields => {
  const match = SEMVER_PATTERN.exec(version.trim());
  if (!match) {
    throw new InstanceApiError(`Invalid semver version: ${version}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? '',
    build: match[5] ?? '',
  };
};

/**
 * Deterministic commit for a seeded release derived from the balenaCloud
 * release identity (open-balena-api caps commit at 40 chars).
 */
export const commitForCloudRelease = (cloudReleaseId: number, rawVersion: string): string =>
  createHash('sha256').update(`${cloudReleaseId}:${rawVersion}`).digest('hex').slice(0, 40);

/** Ensure an organization with the given handle exists; return its id. */
export const ensureOrganization = async (auth: InstanceAuth, handle: string): Promise<number> => {
  const rows = await odataGet<{ id: number }>(
    auth,
    `/v6/organization?$select=id&$filter=handle%20eq%20'${handle}'&$top=1`,
  );
  if (rows[0]) {
    return rows[0].id;
  }

  const created = await odataPost<{ id: number }>(auth, 'organization', { name: handle, handle });
  return created.id;
};

/** Resolve the application_type to use for supervisor apps (version-tolerant). */
export const findSupervisorApplicationType = async (auth: InstanceAuth): Promise<number> => {
  const rows = await odataGet<{ id: number; name: string; slug: string }>(
    auth,
    `/v6/application_type?$select=id,name,slug&$top=100`,
  );

  const preferred = rows.find((row) => row.slug === 'default') ?? rows.find((row) => row.name === 'App');
  return preferred?.id ?? rows[0]?.id ?? 1;
};

/**
 * Create the supervisor application for an arch. The instance generates
 * `slug` as `<orgHandle>/<appName>` (and forces should_track_latest_release on
 * POST), so this creates the `balena_os` organization when needed and PATCHes
 * track-latest back to false afterwards. Callers must have checked
 * `findApplicationBySlug` first for idempotency.
 */
export const createSupervisorApplication = async (
  auth: InstanceAuth,
  arch: string,
  deviceTypeId: number,
): Promise<{ id: number }> => {
  const organizationId = await ensureOrganization(auth, 'balena_os');
  const applicationType = await findSupervisorApplicationType(auth);
  const appName = `${arch}-supervisor`;

  const created = await odataPost<{ id: number; slug?: string }>(auth, 'application', {
    app_name: appName,
    organization: organizationId,
    application_type: applicationType,
    is_for__device_type: deviceTypeId,
    is_host: false,
    is_public: true,
    should_track_latest_release: false,
    is_of__class: 'app',
  });

  // The POST hook forces should_track_latest_release=true; supervisor fleets pin releases per-device.
  await odataPatch(auth, `/v6/application(${created.id})`, { should_track_latest_release: false });

  const app = (await odataGet<{ slug: string }>(auth, `/v6/application(${created.id})?$select=slug`))[0];
  if (!app || app.slug !== supervisorAppSlug(arch)) {
    throw new InstanceApiError(
      `Created supervisor application has unexpected slug '${app?.slug ?? '<unknown>'}'` +
        ` (expected '${supervisorAppSlug(arch)}')`,
    );
  }

  return { id: created.id };
};

/** Create a service row. */
export const createService = async (auth: InstanceAuth, appId: number, serviceName: string): Promise<{ id: number }> =>
  odataPost<{ id: number }>(auth, 'service', {
    application: appId,
    service_name: serviceName,
  });

/**
 * Read an image row's stored location. The API may assign the location
 * server-side on create (the image-is-stored-at-location hook overwrites the
 * posted value), so callers MUST use this instead of the value they posted.
 */
export const getImageLocation = async (auth: InstanceAuth, imageId: number): Promise<string> => {
  const rows = await odataGet<{ is_stored_at__image_location?: string }>(
    auth,
    `/v6/image?$select=is_stored_at__image_location&$filter=id%20eq%20${imageId}&$top=1`,
  );
  const location = rows[0]?.is_stored_at__image_location;
  if (!location) {
    throw new InstanceApiError(`Image ${imageId} has no is_stored_at__image_location`);
  }
  return location;
};

/** Create image metadata pointing at the instance registry location. */
export const createImage = async (
  auth: InstanceAuth,
  serviceId: number,
  location: string,
  contentHash: string,
): Promise<{ id: number }> => {
  // open-balena-api requires every image with status 'success' to carry a push timestamp.
  const timestamp = new Date().toISOString();
  return odataPost<{ id: number }>(auth, 'image', {
    is_a_build_of__service: serviceId,
    is_stored_at__image_location: location,
    content_hash: contentHash,
    status: 'success',
    start_timestamp: timestamp,
    push_timestamp: timestamp,
  });
};

/** Create the supervisor release row (version-field tolerant). */
export const createRelease = async (auth: InstanceAuth, input: CreateReleaseInput): Promise<{ id: number }> => {
  const now = new Date().toISOString();
  const versionField = await releaseVersionField(auth);
  const body: Record<string, unknown> = {
    belongs_to__application: input.appId,
    commit: input.commit,
    composition: input.composition,
    status: 'success',
    source: 'cloud',
    variant: '',
    start_timestamp: now,
    update_timestamp: now,
    [versionField]: input.rawVersion,
    semver_major: input.semver.major,
    semver_minor: input.semver.minor,
    semver_patch: input.semver.patch,
    semver_prerelease: input.semver.prerelease,
    semver_build: input.semver.build,
  };

  if (await releaseSupportsField(auth, 'is_final')) {
    body.is_final = true;
  }

  return odataPost<{ id: number }>(auth, 'release', body);
};

/** Link an image into a release. */
export const createReleaseImage = async (auth: InstanceAuth, releaseId: number, imageId: number): Promise<void> => {
  // The v6 field for the release FK is `is_part_of__release` (the DB column is
  // 'is part of-release'); posting `release` silently nulls it → NOT NULL 500.
  await odataPost<{ id: number }>(auth, 'release_image', {
    is_part_of__release: releaseId,
    image: imageId,
  });
};

// ---------------------------------------------------------------------------
// Device supervisor target
// ---------------------------------------------------------------------------

export interface DeviceSupervisorState {
  current: string | null;
  targetReleaseId: number | null;
  targetRawVersion: string | null;
  targetSemver: string | null;
}

/** Read a device's supervisor state incl. its managed-by release target. */
export const getDeviceSupervisorState = async (
  auth: InstanceAuth,
  deviceId: number,
): Promise<DeviceSupervisorState> => {
  const versionField = await releaseVersionField(auth);

  interface TargetRow {
    id?: number;
    raw_version?: string;
    release_version?: string;
    semver?: string;
  }

  interface Row {
    supervisor_version?: string | null;
    should_be_managed_by__release?: TargetRow[] | TargetRow | null;
  }

  const rows = await odataGet<Row>(
    auth,
    `/v6/device(${deviceId})?$select=supervisor_version,should_be_managed_by__release` +
      `&$expand=should_be_managed_by__release($select=id,${versionField},semver)`,
  );

  const row = rows[0];
  if (!row) {
    throw new NotFoundError(`Unknown device: ${deviceId}`);
  }

  const target = asArray(row.should_be_managed_by__release)[0] ?? null;
  const targetRawVersion =
    (target ? (versionField === 'raw_version' ? target.raw_version : target.release_version) : null) ?? null;
  const targetSemver = target?.semver ?? targetRawVersion;

  return {
    current: row.supervisor_version ?? null,
    targetReleaseId: target?.id ?? null,
    targetRawVersion,
    targetSemver: targetSemver ?? null,
  };
};
/** PATCH a device's `should be managed by-release` (pine canonical name). */
export const patchDeviceSupervisorRelease = async (
  auth: InstanceAuth,
  deviceId: number,
  releaseId: number,
): Promise<void> => {
  const res = await odataPatch(auth, `/v6/device(${deviceId})`, {
    should_be_managed_by__release: releaseId,
  });

  if (!res.ok) {
    throw new InstanceApiError(await extractErrorMessage(res, `Device update failed (${res.status})`), 400);
  }
};
