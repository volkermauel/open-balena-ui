import { OsImageError } from './errors';
import type { FleetConfigOptions } from './cacheStore';

const openBalenaApiUrl = (): string => {
  const url = process.env.REACT_APP_OPEN_BALENA_API_URL;
  if (!url) {
    throw new OsImageError(500, 'REACT_APP_OPEN_BALENA_API_URL is not configured on the ui server');
  }
  return url.replace(/\/+$/, '');
};

/**
 * Build the `/download-config` request body. `undefined` optional fields are omitted so the
 * body only carries explicitly provided options.
 */
export const buildDownloadConfigBody = (options: FleetConfigOptions): Record<string, unknown> => {
  const body: Record<string, unknown> = {
    appId: options.appId,
    version: options.version,
    network: options.network,
  };

  if (options.appUpdatePollInterval !== undefined) {
    body.appUpdatePollInterval = options.appUpdatePollInterval;
  }
  if (options.developmentMode !== undefined) {
    body.developmentMode = options.developmentMode;
  }
  if (options.wifiSsid !== undefined) {
    body.wifiSsid = options.wifiSsid;
  }
  if (options.wifiKey !== undefined) {
    body.wifiKey = options.wifiKey;
  }

  return body;
};

/**
 * Generate the fleet provisioning config.json via openBalena's `POST /download-config`,
 * forwarding the calling user's own Authorization header (D4: the config is generated with
 * exactly the permissions of the logged-in user; there is no server-side service account).
 */
export const generateFleetConfig = async (
  authorization: string | undefined,
  options: FleetConfigOptions,
): Promise<Record<string, unknown>> => {
  if (!authorization) {
    throw new OsImageError(401, 'Missing Authorization header for fleet config generation');
  }

  const apiUrl = openBalenaApiUrl();

  let response: Response;
  try {
    response = await fetch(`${apiUrl}/download-config`, {
      method: 'POST',
      headers: {
        'Authorization': authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildDownloadConfigBody(options)),
    });
  } catch (error) {
    if (error instanceof OsImageError) {
      throw error;
    }
    throw new OsImageError(
      502,
      `Failed to reach openBalena for fleet config generation: ${
        error instanceof Error ? error.message : 'unknown network error'
      }`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new OsImageError(
      401,
      `openBalena rejected the fleet config request (${response.status}); your session may have expired`,
    );
  }

  if (!response.ok) {
    throw new OsImageError(502, `openBalena fleet config generation failed with status ${response.status}`);
  }

  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    throw new OsImageError(502, 'openBalena fleet config generation returned an invalid response body');
  }
};
