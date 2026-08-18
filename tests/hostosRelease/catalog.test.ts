import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_HOSTOS_SOURCE_REGISTRY,
  hostappApplicationSlug,
  hostosCommit,
  hostosTargetRepo,
  isRegistryTag,
  machineForDeviceType,
  orderHostosTags,
  parseHostosSourceRegistry,
  parseHostosTag,
  sourceRepo,
} from '../../server/controller/hostosRelease/catalog';
import { hostosCommit } from '../../server/controller/hostosRelease/instance';
import { HostosNotConfiguredError } from '../../server/controller/hostosRelease/errors';

test('ghcr tags parse into balenaOS versions by reversing the +-to-- swap', () => {
  assert.deepEqual(parseHostosTag('7.4.0-rev5'), { tag: '7.4.0-rev5', version: '7.4.0+rev5' });
  assert.deepEqual(parseHostosTag('v19.0.8'), { tag: 'v19.0.8', version: '19.0.8' });
  assert.deepEqual(parseHostosTag('19.0.8'), { tag: '19.0.8', version: '19.0.8' });
  assert.deepEqual(parseHostosTag('2.113.11+rev1'.replace('+', '-')), {
    tag: '2.113.11-rev1',
    version: '2.113.11+rev1',
  });
});

test('non-version tags are not parsed', () => {
  assert.equal(parseHostosTag('latest'), null);
  assert.equal(parseHostosTag('edge'), null);
  assert.equal(parseHostosTag('7.4'), null);
  assert.equal(parseHostosTag(''), null);
  assert.equal(parseHostosTag('../../evil'), null);
});

test('versions order newest-first with unparsable tags last in raw string order', () => {
  const ordered = orderHostosTags(['19.0.8', '7.4.0-rev5', 'latest', 'v19.0.8', '7.4.0-rev4', 'edge']);

  assert.deepEqual(
    ordered.map((entry) => entry.version),
    ['19.0.8', '7.4.0+rev5', '7.4.0+rev4', 'latest', 'edge'],
  );
  assert.deepEqual(
    ordered.map((entry) => entry.parsable),
    [true, true, true, false, false],
  );
  assert.equal(ordered[0].tag, '19.0.8', 'equal versions dedupe to the first tag');
});

test('registry tags are shape-checked before use in URLs', () => {
  assert.equal(isRegistryTag('7.4.0-rev5'), true);
  assert.equal(isRegistryTag('v19.0.8'), true);
  assert.equal(isRegistryTag('../evil'), false);
  assert.equal(isRegistryTag('a/b'), false);
});

test('source registry env parses host and repository path in all accepted forms', () => {
  const expected = { host: 'ghcr.io', url: 'https://ghcr.io', pathPrefix: 'volkermauel/balenaos-hostapp' };
  assert.deepEqual(parseHostosSourceRegistry('ghcr.io/volkermauel/balenaos-hostapp'), expected);
  assert.deepEqual(parseHostosSourceRegistry('https://ghcr.io/volkermauel/balenaos-hostapp'), expected);
  assert.deepEqual(parseHostosSourceRegistry('ghcr.io/volkermauel/balenaos-hostapp/'), expected);

  assert.deepEqual(parseHostosSourceRegistry('registry.example.com:5000/owner/prefix'), {
    host: 'registry.example.com:5000',
    url: 'https://registry.example.com:5000',
    pathPrefix: 'owner/prefix',
  });
  assert.deepEqual(parseHostosSourceRegistry('http://localhost:5000/owner/prefix'), {
    host: 'localhost:5000',
    url: 'http://localhost:5000',
    pathPrefix: 'owner/prefix',
  });
  assert.deepEqual(parseHostosSourceRegistry('ghcr.io'), {
    host: 'ghcr.io',
    url: 'https://ghcr.io',
    pathPrefix: '',
  });

  assert.deepEqual(
    sourceRepo(parseHostosSourceRegistry(DEFAULT_HOSTOS_SOURCE_REGISTRY), 'raspberrypi4-64'),
    'volkermauel/balenaos-hostapp/raspberrypi4-64',
  );
});

test('source registry values without a registry host are rejected', () => {
  assert.throws(() => parseHostosSourceRegistry('owner/repo'), HostosNotConfiguredError);
  assert.throws(() => parseHostosSourceRegistry(''), HostosNotConfiguredError);
  assert.throws(() => parseHostosSourceRegistry('https://owner/repo'), HostosNotConfiguredError);
});

test('device type slugs map to machines, hostapp slugs and target repos', () => {
  assert.equal(machineForDeviceType('raspberrypi4-64'), 'raspberrypi4-64');
  assert.equal(hostappApplicationSlug('raspberrypi5'), 'admin/raspberrypi5');
  assert.equal(hostosTargetRepo('raspberrypi4-64'), 'balenaos-hostapp/raspberrypi4-64');
});

test('the import commit is deterministic, derived from machine and tag, capped at 40 chars', () => {
  const first = hostosCommit('raspberrypi4-64', '7.4.0-rev5');
  assert.equal(first, hostosCommit('raspberrypi4-64', '7.4.0-rev5'));
  assert.notEqual(first, hostosCommit('raspberrypi5', '7.4.0-rev5'));
  assert.equal(first.length, 40);
  assert.match(first, /^[a-f0-9]+$/);
});
