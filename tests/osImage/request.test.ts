import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_APP_UPDATE_POLL_INTERVAL,
  parseOsConfigRequest,
  parsePrepareOsImageRequest,
} from '../../server/controller/osImage/request';
import { OsImageError } from '../../server/controller/osImage/errors';

const baseBody = {
  deviceType: 'raspberrypi4-64',
  version: '7.4.0+rev5',
  variant: 'production',
  format: 'zip',
  appId: 42,
  fleetName: 'My Fleet',
  network: 'ethernet',
};

const expectRejection = (body: unknown, status: number, messagePattern: RegExp): void => {
  assert.throws(
    () => parsePrepareOsImageRequest(body),
    (error: unknown) => {
      assert.ok(error instanceof OsImageError);
      assert.equal(error.statusCode, status);
      assert.match(error.message, messagePattern);
      return true;
    },
  );
};

test('a valid production prepare request parses', () => {
  assert.deepEqual(parsePrepareOsImageRequest(baseBody), {
    deviceType: 'raspberrypi4-64',
    version: '7.4.0+rev5',
    variant: 'production',
    format: 'zip',
    appId: 42,
    fleetName: 'My Fleet',
    network: 'ethernet',
    appUpdatePollInterval: DEFAULT_APP_UPDATE_POLL_INTERVAL,
  });
});

test('development (and any other) variant is rejected with 406 naming the accepted value', () => {
  expectRejection({ ...baseBody, variant: 'development' }, 406, /accepted value: 'production'/);
  expectRejection({ ...baseBody, variant: '' }, 406, /accepted value: 'production'/);
  expectRejection({ ...baseBody, variant: 'prod' }, 406, /invalid variant/);
  const { variant: _omitted, ...withoutVariant } = baseBody;
  expectRejection(withoutVariant, 406, /invalid variant/);
});

test('appUpdatePollInterval defaults to 10 when omitted or null', () => {
  assert.equal(parsePrepareOsImageRequest(baseBody).appUpdatePollInterval, 10);
  assert.equal(parsePrepareOsImageRequest({ ...baseBody, appUpdatePollInterval: null }).appUpdatePollInterval, 10);
  assert.equal(DEFAULT_APP_UPDATE_POLL_INTERVAL, 10);
});

test('an explicit appUpdatePollInterval is kept and must be >= 1', () => {
  assert.equal(parsePrepareOsImageRequest({ ...baseBody, appUpdatePollInterval: 30 }).appUpdatePollInterval, 30);

  expectRejection({ ...baseBody, appUpdatePollInterval: 0 }, 406, /invalid appUpdatePollInterval/);
  expectRejection({ ...baseBody, appUpdatePollInterval: -5 }, 406, /invalid appUpdatePollInterval/);
  expectRejection({ ...baseBody, appUpdatePollInterval: 'ten' }, 406, /invalid appUpdatePollInterval/);
});

test('missing or invalid fields keep the existing 406 messages', () => {
  expectRejection({ ...baseBody, deviceType: '' }, 406, /lacking deviceType, version or fleetName/);
  expectRejection({ ...baseBody, version: '1.0.0 evil' }, 406, /invalid version/);
  expectRejection({ ...baseBody, deviceType: '../img' }, 406, /invalid deviceType/);
  expectRejection({ ...baseBody, format: 'tar' }, 406, /invalid format/);
  expectRejection({ ...baseBody, network: 'modem' }, 406, /invalid network/);
  expectRejection({ ...baseBody, appId: 0 }, 406, /lacking a valid appId/);
  expectRejection({ ...baseBody, network: 'wifi' }, 406, /lacking wifiSsid/);
  expectRejection(undefined, 406, /lacking deviceType, version or fleetName/);
});

test('wifi options are forwarded only when present', () => {
  const parsed = parsePrepareOsImageRequest({
    ...baseBody,
    network: 'wifi',
    wifiSsid: 'home-network',
    wifiKey: 'secret',
  });
  assert.equal(parsed.network, 'wifi');
  assert.equal(parsed.wifiSsid, 'home-network');
  assert.equal(parsed.wifiKey, 'secret');

  const withoutKey = parsePrepareOsImageRequest({ ...baseBody, network: 'wifi', wifiSsid: 'net', wifiKey: '' });
  assert.equal(withoutKey.wifiSsid, 'net');
  assert.equal(withoutKey.wifiKey, undefined);
});

const baseConfigBody = {
  deviceType: 'raspberrypi4-64',
  version: '7.4.0+rev5',
  appId: 42,
  fleetName: 'My Fleet',
  network: 'ethernet',
};

test('a config-only request parses without variant or format', () => {
  assert.deepEqual(parseOsConfigRequest(baseConfigBody), {
    deviceType: 'raspberrypi4-64',
    version: '7.4.0+rev5',
    appId: 42,
    fleetName: 'My Fleet',
    network: 'ethernet',
    appUpdatePollInterval: DEFAULT_APP_UPDATE_POLL_INTERVAL,
  });
});

test('config requests accept wifi credentials with any network choice', () => {
  // The optional-wifi capability: ethernet + credentials embed wifi as a fallback.
  assert.deepEqual(parseOsConfigRequest({ ...baseConfigBody, wifiSsid: 'home', wifiKey: 'secret' }), {
    deviceType: 'raspberrypi4-64',
    version: '7.4.0+rev5',
    appId: 42,
    fleetName: 'My Fleet',
    network: 'ethernet',
    appUpdatePollInterval: DEFAULT_APP_UPDATE_POLL_INTERVAL,
    wifiSsid: 'home',
    wifiKey: 'secret',
  });

  assert.deepEqual(parseOsConfigRequest({ ...baseConfigBody, network: 'wifi', wifiSsid: 'home' }).wifiSsid, 'home');
});

const expectConfigRejection = (body: unknown, status: number, messagePattern: RegExp): void => {
  assert.throws(
    () => parseOsConfigRequest(body),
    (error: unknown) => {
      assert.ok(error instanceof OsImageError);
      assert.equal(error.statusCode, status);
      assert.match(error.message, messagePattern);
      return true;
    },
  );
};

test('config requests keep the prepare validation contract', () => {
  expectConfigRejection({ ...baseConfigBody, network: 'wifi' }, 406, /lacking wifiSsid/);
  expectConfigRejection({ ...baseConfigBody, network: 'modem' }, 406, /invalid network/);
  expectConfigRejection({ ...baseConfigBody, appId: 0 }, 406, /lacking a valid appId/);
  expectConfigRejection({ ...baseConfigBody, version: '1.0.0 evil' }, 406, /invalid version/);
  expectConfigRejection({ ...baseConfigBody, fleetName: '' }, 406, /lacking deviceType, version or fleetName/);
  expectConfigRejection({ ...baseConfigBody, appUpdatePollInterval: 0 }, 406, /invalid appUpdatePollInterval/);
});
