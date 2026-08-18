import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeFleetRecords } from '../../src/lib/osImage';
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

test('mergeFleetRecords merges mixed id types by string value (server record wins)', () => {
  const merged = mergeFleetRecords([fleet(42, 10, 'seeded name')], [fleet('42', 10, 'server name')]);
  assert.equal(merged.length, 1, "number 42 and string '42' are the same fleet");
  assert.equal(merged[0].id, '42');
  assert.equal(merged[0]['app name'], 'server name');
});

test('mergeFleetRecords keeps the seeded fleet when the list request returns nothing usable', () => {
  const seeded = [fleet('abc', 7)];
  assert.deepEqual(mergeFleetRecords(seeded, []), seeded);
  assert.deepEqual(mergeFleetRecords([], []), []);
});
