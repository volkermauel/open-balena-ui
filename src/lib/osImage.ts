import type { ResourceRecord } from '../types/resource';

export type OsImageVariant = 'production' | 'development';
export type OsImageFormat = 'zip' | 'gz';
export type OsImageNetwork = 'ethernet' | 'wifi';
export type OsImageJobPhase = 'downloading' | 'injecting' | 'compressing' | 'ready' | 'error';

export interface OsImageVersionsResponse {
  versions: string[];
}

export interface OsImageCachedVersion {
  version: string;
  variant: OsImageVariant;
  cached: boolean;
  artifactCount: number;
  totalBytes: number;
}

export interface OsImageCacheStatusResponse {
  deviceType: string;
  versions: OsImageCachedVersion[];
}

export interface PrepareOsImageRequest {
  deviceType: string;
  version: string;
  variant: OsImageVariant;
  format: OsImageFormat;
  appId: number;
  fleetName: string;
  network: OsImageNetwork;
  appUpdatePollInterval?: number;
  wifiSsid?: string;
  wifiKey?: string;
}

export interface OsImageJobArtifact {
  filename: string;
  sizeBytes: number;
  format: OsImageFormat;
}

export interface OsImageJob {
  jobId: string;
  phase: OsImageJobPhase;
  progress?: { downloadedBytes: number; totalBytes?: number };
  error?: string;
  artifact?: OsImageJobArtifact;
}

export interface OsImageRequestError extends Error {
  status?: number;
}

/**
 * The JWT is kept in localStorage under the 'auth' key by the authProvider (see
 * src/authProvider/openbalenaAuthProvider.ts); the dataProvider uses the same source.
 */
export const readOsImageAuthToken = (): string | null => window.localStorage.getItem('auth');

const authHeaders = (extra?: HeadersInit): Headers => {
  const headers = new Headers(extra);
  headers.set('Accept', 'application/json');
  const token = readOsImageAuthToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return headers;
};

const requestOsImage = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    ...(init?.body !== undefined ? { body: init.body } : {}),
    headers: authHeaders(init?.headers),
  });

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    try {
      const body = (await response.json()) as { message?: string };
      if (body && typeof body.message === 'string' && body.message.length > 0) {
        message = body.message;
      }
    } catch {
      // Non-JSON error body; keep the generic message.
    }
    const error = new Error(message) as OsImageRequestError;
    error.status = response.status;
    throw error;
  }

  return (await response.json()) as T;
};

export const fetchOsImageVersions = (deviceType: string): Promise<OsImageVersionsResponse> =>
  requestOsImage<OsImageVersionsResponse>(`/os-images/versions?deviceType=${encodeURIComponent(deviceType)}`);

export const fetchOsImageCacheStatus = (deviceType: string): Promise<OsImageCacheStatusResponse> =>
  requestOsImage<OsImageCacheStatusResponse>(`/os-images/cache-status?deviceType=${encodeURIComponent(deviceType)}`);

export const prepareOsImage = (request: PrepareOsImageRequest): Promise<{ jobId: string }> =>
  requestOsImage<{ jobId: string }>('/os-images/prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

export const fetchOsImageJob = (jobId: string): Promise<OsImageJob> =>
  requestOsImage<OsImageJob>(`/os-images/jobs/${encodeURIComponent(jobId)}`);

const filenameFromContentDisposition = (header: string | null): string | null => {
  if (!header) {
    return null;
  }
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  return match ? decodeURIComponent(match[1].trim()) : null;
};

/**
 * Fetch the prepared artifact with the session JWT and hand the blob to the browser via a
 * temporary object URL (plain navigation cannot attach the Authorization header).
 */
export const downloadOsImageArtifact = async (job: OsImageJob): Promise<string> => {
  const response = await fetch(`/os-images/jobs/${encodeURIComponent(job.jobId)}/download`, {
    headers: authHeaders(),
  });

  if (!response.ok) {
    let message = `Download failed with status ${response.status}`;
    try {
      const body = (await response.json()) as { message?: string };
      if (body && typeof body.message === 'string' && body.message.length > 0) {
        message = body.message;
      }
    } catch {
      // Non-JSON error body; keep the generic message.
    }
    const error = new Error(message) as OsImageRequestError;
    error.status = response.status;
    throw error;
  }

  const blob = await response.blob();
  const filename =
    filenameFromContentDisposition(response.headers.get('content-disposition')) ??
    job.artifact?.filename ??
    'balena-image';
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);

  return filename;
};

/**
 * Merge server-side fleet records into the seeded dropdown list: deduplicated by
 * id with the server records winning over the locally seeded one. Pure — unit tested.
 */
export const mergeFleetRecords = (seeded: ResourceRecord[], incoming: ResourceRecord[]): ResourceRecord[] => {
  const merged = [...incoming];
  for (const record of seeded) {
    if (!merged.some((candidate) => String(candidate.id) === String(record.id))) {
      merged.push(record);
    }
  }
  return merged;
};

/**
 * A fleet belongs to the selected device type when its `is for-device type` reference
 * matches the device type's id (openBalena OData has no usable class filter, so the
 * wizard filters client-side). Pure — unit tested.
 */
export const fleetMatchesDeviceType = (fleet: ResourceRecord, deviceTypeId: string | number | undefined): boolean =>
  deviceTypeId === undefined || String(fleet['is for-device type']) === String(deviceTypeId);
