import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CloudRelease,
  dedupeAndOrderReleases,
  supervisorAppSlug,
  isSafeODataToken,
} from '../../server/controller/supervisorRelease/cloud';

const release = (id: number, raw: string, semver: string, variant = ''): CloudRelease => ({
  id,
  raw_version: raw,
  semver,
  variant,
  composition: {},
});

test('dedupe keeps the newest raw_version per semver', () => {
  // Ordered as the API returns them: $orderby=id desc
  const releases = [
    release(30, '19.0.9-1786970539365', '19.0.9'),
    release(29, '19.0.9-1786819799993', '19.0.9'),
    release(28, '19.0.8', '19.0.8'),
  ];

  const versions = dedupeAndOrderReleases(releases);

  assert.equal(versions.length, 2);
  assert.equal(versions[0].semver, '19.0.9');
  assert.equal(versions[0].rawVersion, '19.0.9-1786970539365');
  assert.equal(versions[0].cloudReleaseId, 30);
});

test('dedupe drops empty semver/raw_version rows', () => {
  const releases = [
    release(30, '19.0.9', '19.0.9'),
    { id: 31, raw_version: '', semver: '', variant: '', composition: {} },
    { id: 32, raw_version: 'x', semver: '', variant: '', composition: {} },
  ];

  assert.equal(dedupeAndOrderReleases(releases).length, 1);
});

test('versions are ordered semver-descending (balena-semver, prereleases first)', () => {
  const releases = [
    release(10, '19.0.2', '19.0.2'),
    release(9, '19.0.10', '19.0.10'),
    release(8, '19.0.9', '19.0.9'),
    release(7, '20.0.0rev1', '20.0.0'),
  ];

  const ordered = dedupeAndOrderReleases(releases).map((entry) => entry.semver);

  assert.deepEqual(ordered, ['20.0.0', '19.0.10', '19.0.9', '19.0.2']);
});

test('arch maps to the balenaCloud supervisor app slug', () => {
  assert.equal(supervisorAppSlug('aarch64'), 'balena_os/aarch64-supervisor');
  assert.equal(supervisorAppSlug('amd64'), 'balena_os/amd64-supervisor');
  assert.equal(supervisorAppSlug('armv7hf'), 'balena_os/armv7hf-supervisor');
});

test('OData filter tokens are restricted to safe characters', () => {
  assert.equal(isSafeODataToken('aarch64'), true);
  assert.equal(isSafeODataToken('i386-nlp'), true);
  assert.equal(isSafeODataToken("aarch64'"), false);
  assert.equal(isSafeODataToken('aarch64 OR 1=1'), false);
  assert.equal(isSafeODataToken('%20'), false);
});
