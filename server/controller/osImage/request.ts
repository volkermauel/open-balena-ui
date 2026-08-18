import { OsImageError } from './errors';
import {
  isValidDeviceTypeSlug,
  isValidOsVersion,
  type OsImageFormat,
  type OsImageNetwork,
  type OsImageVariant,
} from './cacheStore';
import type { PrepareOsImageRequest } from './prepareJob';

const FORMATS: OsImageFormat[] = ['zip', 'gz'];
const NETWORKS: OsImageNetwork[] = ['ethernet', 'wifi'];

/** The mirror publishes production images only; prepare requests accept exactly this variant. */
export const ACCEPTED_VARIANT: OsImageVariant = 'production';

/** Devices poll for app updates every 10 minutes unless the request says otherwise. */
export const DEFAULT_APP_UPDATE_POLL_INTERVAL = 10;

interface PrepareOsImageRequestBody {
  deviceType?: unknown;
  version?: unknown;
  variant?: unknown;
  format?: unknown;
  appId?: unknown;
  fleetName?: unknown;
  network?: unknown;
  appUpdatePollInterval?: unknown;
  wifiSsid?: unknown;
  wifiKey?: unknown;
}

/**
 * Parse and validate a `POST /os-images/prepare` body into a `PrepareOsImageRequest`.
 * Invalid input throws `OsImageError` with the HTTP status and message the route
 * forwards verbatim. `appUpdatePollInterval` defaults to
 * `DEFAULT_APP_UPDATE_POLL_INTERVAL` when omitted or null. Pure — unit tested.
 */
export const parsePrepareOsImageRequest = (body: unknown): PrepareOsImageRequest => {
  const raw = (body && typeof body === 'object' ? body : {}) as PrepareOsImageRequestBody;

  const deviceType = typeof raw.deviceType === 'string' ? raw.deviceType.trim() : '';
  const version = typeof raw.version === 'string' ? raw.version.trim() : '';
  const fleetName = typeof raw.fleetName === 'string' ? raw.fleetName.trim() : '';
  const variant = typeof raw.variant === 'string' ? raw.variant : '';
  const format = typeof raw.format === 'string' ? raw.format : '';
  const network = typeof raw.network === 'string' ? raw.network : '';
  const appId = Number(raw.appId);
  const appUpdatePollInterval =
    raw.appUpdatePollInterval === undefined || raw.appUpdatePollInterval === null
      ? DEFAULT_APP_UPDATE_POLL_INTERVAL
      : Number(raw.appUpdatePollInterval);
  const wifiSsid = typeof raw.wifiSsid === 'string' && raw.wifiSsid.length > 0 ? raw.wifiSsid : undefined;
  const wifiKey = typeof raw.wifiKey === 'string' && raw.wifiKey.length > 0 ? raw.wifiKey : undefined;

  if (!deviceType || !version || !fleetName) {
    throw new OsImageError(406, 'Request is lacking deviceType, version or fleetName in body context');
  }
  if (!isValidDeviceTypeSlug(deviceType)) {
    throw new OsImageError(406, 'Request has an invalid deviceType in body context');
  }
  if (!isValidOsVersion(version)) {
    throw new OsImageError(406, 'Request has an invalid version in body context');
  }
  if (variant !== ACCEPTED_VARIANT) {
    throw new OsImageError(
      406,
      `Request has an invalid variant in body context (accepted value: '${ACCEPTED_VARIANT}')`,
    );
  }
  if (!FORMATS.includes(format as OsImageFormat)) {
    throw new OsImageError(406, 'Request has an invalid format in body context');
  }
  if (!NETWORKS.includes(network as OsImageNetwork)) {
    throw new OsImageError(406, 'Request has an invalid network in body context');
  }
  if (!Number.isInteger(appId) || appId <= 0) {
    throw new OsImageError(406, 'Request is lacking a valid appId in body context');
  }
  if (!Number.isFinite(appUpdatePollInterval) || appUpdatePollInterval < 1) {
    throw new OsImageError(406, 'Request has an invalid appUpdatePollInterval in body context');
  }
  if (network === 'wifi' && !wifiSsid) {
    throw new OsImageError(406, 'Request is lacking wifiSsid in body context');
  }

  return {
    deviceType,
    version,
    variant: ACCEPTED_VARIANT,
    format: format as OsImageFormat,
    appId,
    fleetName,
    network: network as OsImageNetwork,
    appUpdatePollInterval,
    ...(wifiSsid !== undefined ? { wifiSsid } : {}),
    ...(wifiKey !== undefined ? { wifiKey } : {}),
  };
};
