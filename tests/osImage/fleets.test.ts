import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fleetMatchesDeviceType, mergeFleetRecords } from '../../src/lib/osImage';
import type { ResourceRecord } from '../../src/types/resource';

const fleet = (id: number | string, deviceTypeId: number | string, name = `fleet-${id}`): ResourceRecord =>
  ({
    id,
    'app name': name,
    'is for-device type': deviceTypeId,
  }) as ResourceRecord;

test('mergeFleetRecords dedupes by id and keeps the server records', () => {
  const seeded = [fleet(1, 10, 'seeded name'), fleet(2, 20)];
  const incoming = [fleet(1, 10, 'server name (fresher)'), fleet(3, 30)];

  const merged = mergeFleetRecords(seeded, incoming);
  assert.deepEqual(
    merged.map((record) => record.id),
    [1, 3, 2],
  );
  assert.equal(merged[0]['app name'], 'server name (fresher)', 'server record wins over the seeded one');
});

test('mergeFleetRecords keeps the seeded fleet when the list request returns nothing usable', () => {
  const seeded = [fleet('abc', 7)];
  assert.deepEqual(mergeFleetRecords(seeded, []), seeded);
  assert.deepEqual(mergeFleetRecords([], []), []);
});

test('fleetMatchesDeviceType compares the is-for-device-type reference as a string', () => {
  const record = fleet(1, 42);

  assert.equal(fleetMatchesDeviceType(record, 42), true);
  assert.equal(fleetMatchesDeviceType(record, '42'), true);
  assert.equal(fleetMatchesDeviceType(record, 43), false);

  // Without a device-type selection every fleet matches (dropdown never empty on open).
  assert.equal(fleetMatchesDeviceType(record, undefined), true);
});
