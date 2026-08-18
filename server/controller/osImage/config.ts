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
 * Public-key line shape accepted in `GATEWAY_SSH_PUBLIC_KEYS`: the openssh authorized-key
 * families — plain (`ssh-rsa`, `ssh-dss`, `ssh-ed25519`, `ecdsa-sha2-nistp{256,384,521}`),
 * hardware-backed (`sk-ssh-ed25519@openssh.com`, `sk-ecdsa-sha2-nistp256@openssh.com`) and
 * certificate (`…-cert-v01@openssh.com`) forms — each with base64 key material and an
 * optional trailing comment. The design doc's `^ssh-(rsa|dss|ed25519|ecdsa)-` sketch cannot
 * match any real key (`ssh-rsa`/`ssh-ed25519` carry no second hyphen, ecdsa keys are
 * `ecdsa-sha2-nistp256`-prefixed), so the families' actual formats are accepted.
 */
const GATEWAY_SSH_PUBLIC_KEY_PATTERN =
  /^((sk-)?(ssh-(rsa|dss|ed25519)|ecdsa-sha2-nistp(256|384|521)))(-cert-v01)?(@openssh\.com)?\s+[A-Za-z0-9+\/=]+(\s+.*)?$/;

/**
 * Parse `GATEWAY_SSH_PUBLIC_KEYS` (newline-separated public keys) at request time:
 * split on newlines, trim, drop empty lines. Every remaining entry must be a
 * well-formed public key or a typed config error naming the env var is thrown.
 * Pure — unit tested.
 */
export const parseGatewaySshPublicKeys = (raw: string | undefined): string[] => {
  if (raw === undefined || raw.trim().length === 0) {
    return [];
  }

  const keys = raw
    .split(/\r?\n/)
    .map((key) => key.trim())
    .filter((key) => key.length > 0);

  for (const key of keys) {
    if (!GATEWAY_SSH_PUBLIC_KEY_PATTERN.test(key)) {
      throw new OsImageError(
        500,
        `GATEWAY_SSH_PUBLIC_KEYS contains an invalid public key (expected '[sk-](ssh-rsa|ssh-dss|ssh-ed25519|ecdsa-sha2-nistp(256|384|521))[-cert-v01][@openssh.com] <base64> [comment]'): ${key.slice(0, 60)}`,
      );
    }
  }

  return keys;
};

/**
 * Merge the configured gateway keys into a generated config.json's `os.sshKeys`
 * (appending after any keys the instance already produced, skipping duplicates).
 * Returns the config untouched when no keys are configured. Pure — unit tested.
 */
export const applyGatewaySshKeys = (config: Record<string, unknown>, keys: string[]): Record<string, unknown> => {
  if (keys.length === 0) {
    return config;
  }

  const os =
    config.os && typeof config.os === 'object' && !Array.isArray(config.os)
      ? (config.os as Record<string, unknown>)
      : {};
  const existing = Array.isArray(os.sshKeys) ? os.sshKeys.filter((key): key is string => typeof key === 'string') : [];
  const sshKeys = [...existing];
  for (const key of keys) {
    if (!sshKeys.includes(key)) {
      sshKeys.push(key);
    }
  }

  return { ...config, os: { ...os, sshKeys } };
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
