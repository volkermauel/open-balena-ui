import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSemverFields, commitForCloudRelease } from '../../server/controller/supervisorRelease/instance';
import {
  deriveRegistryHost,
  inspectManifest,
  withRepoLock,
} from '../../server/controller/supervisorRelease/registryMirror';

test('semver parsing fills the release semver_* fields', () => {
  assert.deepEqual(parseSemverFields('19.0.9'), { major: 19, minor: 0, patch: 9, prerelease: '', build: '' });
  assert.deepEqual(parseSemverFields(' 20.1.3-rev1 '), {
    major: 20,
    minor: 1,
    patch: 3,
    prerelease: 'rev1',
    build: '',
  });
  assert.deepEqual(parseSemverFields('1.2.3-beta.1+build.5'), {
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: 'beta.1',
    build: 'build.5',
  });

  assert.throws(() => parseSemverFields('not-a-version'));
});

test('seed commit is deterministic and capped at 40 chars', () => {
  const first = commitForCloudRelease(4260587, '19.0.9-1786970539365');
  assert.equal(first, commitForCloudRelease(4260587, '19.0.9-1786970539365'));
  assert.notEqual(first, commitForCloudRelease(4260588, '19.0.9-1786970539365'));
  assert.equal(first.length, 40);
  assert.match(first, /^[a-f0-9]+$/);
});

test('registry host derivation replaces the leftmost DNS label with registry2', () => {
  assert.equal(deriveRegistryHost('https://api.balena.example.com'), 'registry2.balena.example.com');
  assert.equal(deriveRegistryHost('https://api.example.org:8080'), 'registry2.example.org:8080');
  assert.throws(() => deriveRegistryHost('https://localhost'));
  assert.throws(() => deriveRegistryHost('not a url'));
});

const singleManifest = {
  schemaVersion: 2,
  mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
  config: {
    mediaType: 'application/vnd.docker.container.image.v1+json',
    size: 2186,
    digest: 'sha256:' + 'a'.repeat(64),
  },
  layers: [
    {
      mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip',
      size: 65011753,
      digest: 'sha256:' + 'b'.repeat(64),
    },
    { mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip', size: 1220, digest: 'sha256:' + 'c'.repeat(64) },
  ],
};

const manifestList = {
  schemaVersion: 2,
  mediaType: 'application/vnd.docker.distribution.manifest.list.v2+json',
  manifests: [
    {
      mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
      size: 1152,
      digest: 'sha256:' + 'd'.repeat(64),
      platform: { architecture: 'arm', os: 'linux', variant: 'v8' },
    },
    {
      mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
      size: 1152,
      digest: 'sha256:' + 'e'.repeat(64),
      platform: { architecture: 'amd64', os: 'linux' },
    },
  ],
};

const ociIndex = {
  schemaVersion: 2,
  mediaType: 'application/vnd.oci.image.index.v1+json',
  manifests: [
    { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: 'sha256:' + 'f'.repeat(64), size: 999 },
  ],
};

test('single manifest inspection yields config + layer blobs, no children', () => {
  const inspection = inspectManifest(singleManifest);

  assert.equal(inspection.isList, false);
  assert.deepEqual(inspection.childManifestDigests, []);
  assert.deepEqual(inspection.blobDigests, [
    'sha256:' + 'a'.repeat(64),
    'sha256:' + 'b'.repeat(64),
    'sha256:' + 'c'.repeat(64),
  ]);
});

test('docker manifest list inspection recurses into child manifests only', () => {
  const inspection = inspectManifest(manifestList);

  assert.equal(inspection.isList, true);
  assert.deepEqual(inspection.childManifestDigests, ['sha256:' + 'd'.repeat(64), 'sha256:' + 'e'.repeat(64)]);
  assert.deepEqual(inspection.blobDigests, []);
});

test('OCI index inspection is treated as a list too', () => {
  const inspection = inspectManifest(ociIndex);

  assert.equal(inspection.isList, true);
  assert.deepEqual(inspection.childManifestDigests, ['sha256:' + 'f'.repeat(64)]);
});

test('manifests without recognized structure are rejected', () => {
  assert.throws(() => inspectManifest({}));
  assert.throws(() => inspectManifest('nope'));
  assert.throws(() => inspectManifest({ manifests: [{ noDigest: true }] }));
});

test('withRepoLock serializes work per repository', async () => {
  const order: string[] = [];

  const first = withRepoLock('repo', async () => {
    order.push('first-start');
    await new Promise((resolve) => setTimeout(resolve, 25));
    order.push('first-end');
  });
  const second = withRepoLock('repo', async () => {
    order.push('second-start');
    await new Promise((resolve) => setTimeout(resolve, 1));
    order.push('second-end');
  });
  const other = withRepoLock('other-repo', async () => {
    order.push('other-start');
  });

  await Promise.all([first, second, other]);

  assert.deepEqual(order, ['first-start', 'other-start', 'first-end', 'second-start', 'second-end']);
});
