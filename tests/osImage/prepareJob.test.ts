import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  artifactDownloadFilename,
  toFleetConfigOptions,
  type PrepareOsImageRequest,
} from '../../server/controller/osImage/prepareJob';
import { configSha16, isValidDeviceTypeSlug, isValidOsVersion } from '../../server/controller/osImage/cacheStore';

const baseRequest: PrepareOsImageRequest = {
  deviceType: 'raspberrypi4-64',
  version: '3.2.7',
  variant: 'production',
  format: 'zip',
  appId: 42,
  fleetName: 'My Fleet',
  network: 'ethernet',
};

test('artifactDownloadFilename sanitizes the fleet name', () => {
  assert.equal(artifactDownloadFilename(baseRequest), 'raspberrypi4-64-3.2.7-My-Fleet.zip');
  assert.equal(
    artifactDownloadFilename({ ...baseRequest, variant: 'development', format: 'gz', fleetName: 'prod / fleet #1' }),
    'raspberrypi4-64-3.2.7-dev-prod-fleet-1.gz',
  );
  assert.equal(artifactDownloadFilename({ ...baseRequest, fleetName: '///' }), 'raspberrypi4-64-3.2.7-fleet.zip');
});

test('artifactDownloadFilename sanitizes hostile device types and versions', () => {
  assert.equal(
    artifactDownloadFilename({ ...baseRequest, deviceType: '../../etc', version: '1.0.0"\r\nX-Evil: x' }),
    '..-..-etc-1.0.0-X-Evil-x-My-Fleet.zip',
  );
});

test('device type slugs are strictly allow-listed', () => {
  assert.equal(isValidDeviceTypeSlug('raspberrypi4-64'), true);
  assert.equal(isValidDeviceTypeSlug('generic-amd64'), true);
  assert.equal(isValidDeviceTypeSlug('fincm3'), true);
  assert.equal(isValidDeviceTypeSlug('../img'), false);
  assert.equal(isValidDeviceTypeSlug('a/b'), false);
  assert.equal(isValidDeviceTypeSlug('.hidden'), false);
  assert.equal(isValidDeviceTypeSlug(''), false);
  assert.equal(isValidDeviceTypeSlug('x'.repeat(65)), false);
});

test('OS versions are strictly allow-listed', () => {
  assert.equal(isValidOsVersion('3.2.7'), true);
  assert.equal(isValidOsVersion('7.4.0+rev5'), true);
  assert.equal(isValidOsVersion('2026.7.0'), true);
  assert.equal(isValidOsVersion('latest'), true);
  assert.equal(isValidOsVersion('../../out/x'), false);
  assert.equal(isValidOsVersion('1.0.0 evil'), false);
  assert.equal(isValidOsVersion(''), false);
});

test('toFleetConfigOptions maps variant and optional fields', () => {
  assert.deepEqual(toFleetConfigOptions(baseRequest), {
    appId: 42,
    version: '3.2.7',
    network: 'ethernet',
  });

  assert.deepEqual(
    toFleetConfigOptions({
      ...baseRequest,
      variant: 'development',
      network: 'wifi',
      appUpdatePollInterval: 10,
      wifiSsid: 'net',
      wifiKey: 'secret',
    }),
    {
      appId: 42,
      version: '3.2.7',
      network: 'wifi',
      appUpdatePollInterval: 10,
      developmentMode: true,
      wifiSsid: 'net',
      wifiKey: 'secret',
    },
  );
});

test('job request fields fully determine the artifact cache key', () => {
  const production = toFleetConfigOptions(baseRequest);
  const development = toFleetConfigOptions({ ...baseRequest, variant: 'development' });

  assert.notEqual(configSha16(production, 'zip'), configSha16(development, 'zip'));
  assert.notEqual(configSha16(production, 'zip'), configSha16(production, 'gz'));
  assert.equal(configSha16(production, 'zip'), configSha16(toFleetConfigOptions(baseRequest), 'zip'));
});
