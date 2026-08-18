/**
 * Typed client for the UI server's `/supervisor-releases` routes.
 * Same-origin requests, authorized with the JWT the authProvider/dataProvider
 * already use (`localStorage.getItem('auth')`).
 */

import * as balenaSemver from 'balena-semver';

export interface SupervisorVersionEntry {
  version: string;
  rawVersion: string;
  seeded: boolean;
  releaseId?: number;
}

export interface SupervisorVersionsResponse {
  deviceType: string;
  arch: string;
  versions: SupervisorVersionEntry[];
  mirroringEnabled: boolean;
}

export interface SupervisorStatusResponse {
  current: string | null;
  targetReleaseId: number | null;
  targetVersion: string | null;
  pending: boolean;
}

export interface SupervisorDeviceUpdateResult {
  id: number;
  ok: boolean;
  message?: string;
}

export interface SupervisorUpdateResponse {
  results: SupervisorDeviceUpdateResult[];
}

export interface SupervisorSeedResponse {
  appId: number;
  releaseId: number;
  images: { repo: string; digest: string }[];
}

const authHeaders = (): Record<string, string> => ({
  Authorization: `Bearer ${localStorage.getItem('auth') ?? ''}`,
});

class SupervisorReleaseError extends Error {
  public readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'SupervisorReleaseError';
    this.status = status;
  }
}

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`/supervisor-releases${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...authHeaders(),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });

  const body = (await response.json().catch(() => null)) as (Record<string, unknown> & { message?: string }) | null;

  if (!response.ok || !body || body.success === false) {
    const message =
      body && typeof body.message === 'string'
        ? body.message
        : `Supervisor release request failed (${response.status})`;
    throw new SupervisorReleaseError(message, response.status);
  }

  return body as T;
};

export const fetchSupervisorVersions = (deviceTypeSlug: string): Promise<SupervisorVersionsResponse> =>
  request<SupervisorVersionsResponse>(`/versions?deviceType=${encodeURIComponent(deviceTypeSlug)}`);

export const fetchSupervisorStatus = (deviceId: number): Promise<SupervisorStatusResponse> =>
  request<SupervisorStatusResponse>(`/status?deviceId=${deviceId}`);

export const seedSupervisorVersion = (deviceTypeSlug: string, version: string): Promise<SupervisorSeedResponse> =>
  request<SupervisorSeedResponse>('/seed', {
    method: 'POST',
    body: JSON.stringify({ deviceType: deviceTypeSlug, version }),
  });

export const updateSupervisorVersions = (
  deviceTypeSlug: string,
  version: string,
  deviceIds: number[],
): Promise<SupervisorUpdateResponse> =>
  request<SupervisorUpdateResponse>('/update', {
    method: 'POST',
    body: JSON.stringify({ deviceType: deviceTypeSlug, version, deviceIds }),
  });

/**
 * True when `candidate` is older than `current` in supervisor semver terms —
 * such versions are listed but disabled ("downgrade not allowed"); the API
 * would reject them anyway. Pure — unit tested.
 */
export const isDowngrade = (candidate: string, current: string | null | undefined): boolean => {
  if (!current) {
    return false;
  }
  try {
    return balenaSemver.compare(candidate, current) < 0;
  } catch {
    return false;
  }
};

/** True when both version strings denote the same supervisor semver (ignoring raw/revision suffixes). Pure — unit tested. */
export const isSameSupervisorVersion = (left: string, right: string | null | undefined): boolean => {
  if (!right) {
    return false;
  }
  // balena-semver treats `-<number>` suffixes as revisions, so `19.0.9` and `19.0.9-1786…`
  // compare unequal; compare the plain `major.minor.patch` part instead.
  const plain = (value: string): string => value.split('-')[0].split('+')[0];
  try {
    return balenaSemver.compare(plain(left), plain(right)) === 0;
  } catch {
    return plain(left) === plain(right);
  }
};
