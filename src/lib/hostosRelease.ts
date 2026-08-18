/**
 * Typed client for the UI server's `/hostos-releases` routes.
 * Same-origin requests, authorized with the JWT the authProvider/dataProvider
 * already use (`localStorage.getItem('auth')`).
 */

export interface HostosVersionEntry {
  version: string;
  rawVersion: string;
  seeded: boolean;
  releaseId?: number;
  parsable: boolean;
}

export interface HostosVersionsResponse {
  deviceType: string;
  machine: string;
  versions: HostosVersionEntry[];
  sourceRepo: string;
}

export interface HostosSeedResponse {
  appId: number;
  releaseId: number;
  image: { repo: string; digest: string };
}

const authHeaders = (): Record<string, string> => ({
  Authorization: `Bearer ${localStorage.getItem('auth') ?? ''}`,
});

class HostosReleaseError extends Error {
  public readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'HostosReleaseError';
    this.status = status;
  }
}

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`/hostos-releases${path}`, {
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
      body && typeof body.message === 'string' ? body.message : `HostOS release request failed (${response.status})`;
    throw new HostosReleaseError(message, response.status);
  }

  return body as T;
};

export const fetchHostosVersions = (deviceTypeSlug: string): Promise<HostosVersionsResponse> =>
  request<HostosVersionsResponse>(`/versions?deviceType=${encodeURIComponent(deviceTypeSlug)}`);

export const seedHostosVersion = (deviceTypeSlug: string, version: string): Promise<HostosSeedResponse> =>
  request<HostosSeedResponse>('/seed', {
    method: 'POST',
    body: JSON.stringify({ deviceType: deviceTypeSlug, version }),
  });
