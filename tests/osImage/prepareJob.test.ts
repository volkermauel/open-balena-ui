import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  artifactDownloadFilename,
  toFleetConfigOptions,
  type PrepareOsImageRequest,
} from '../../server/controller/osImage/prepareJob';
import { configSha16 } from '../../server/controller/osImage/cacheStore';

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
