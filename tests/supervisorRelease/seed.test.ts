import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planSeedSteps, repoFromLocation } from '../../server/controller/supervisorRelease/seed';
import { aggregateResults, DeviceUpdateResult } from '../../server/controller/supervisorRelease/update';
import { isDowngrade, isSameSupervisorVersion } from '../../src/lib/supervisorRelease';

const completeState = {
  appId: 7,
  releaseId: 42,
  existingServiceNames: ['core'],
  existingImageHashes: ['sha256:' + 'a'.repeat(64)],
  existingReleaseImageIds: [101],
  bytesVerified: true,
};

test('a fully seeded version plans no work', () => {
  assert.deepEqual(
    planSeedSteps(completeState, {
      serviceNames: ['core'],
      imageHashes: ['sha256:' + 'a'.repeat(64)],
      imageCount: 1,
    }),
    ['complete'],
  );
});

test('a cold seed plans every step in crash-safe order', () => {
  const steps = planSeedSteps(
    {
      existingServiceNames: [],
      existingImageHashes: [],
      existingReleaseImageIds: [],
      bytesVerified: false,
    },
    { serviceNames: ['core', 'service-relay'], imageHashes: ['sha256:x', 'sha256:y'], imageCount: 2 },
  );

  assert.deepEqual(steps, [
    'create-app',
    'create-service',
    'create-image-metadata',
    'mirror-bytes',
    'create-release',
    'create-release-image',
  ]);
});

test('metadata existing but bytes unverified still mirrors before release', () => {
  const steps = planSeedSteps(
    { ...completeState, releaseId: undefined, bytesVerified: false, existingReleaseImageIds: [] },
    { serviceNames: ['core'], imageHashes: ['sha256:' + 'a'.repeat(64)], imageCount: 1 },
  );

  assert.deepEqual(steps, ['mirror-bytes', 'create-release', 'create-release-image']);
});

test('a crashed seed resumes: bytes there, release missing', () => {
  const steps = planSeedSteps(
    { ...completeState, releaseId: undefined, existingReleaseImageIds: [] },
    { serviceNames: ['core'], imageHashes: ['sha256:' + 'a'.repeat(64)], imageCount: 1 },
  );

  assert.deepEqual(steps, ['create-release', 'create-release-image']);
});

test('release present but not all images linked finishes the links', () => {
  const steps = planSeedSteps(
    {
      ...completeState,
      existingServiceNames: ['core', 'service-relay'],
      existingImageHashes: ['sha256:' + 'a'.repeat(64), 'sha256:' + 'b'.repeat(64)],
      existingReleaseImageIds: [101],
    },
    {
      serviceNames: ['core', 'service-relay'],
      imageHashes: ['sha256:' + 'a'.repeat(64), 'sha256:' + 'b'.repeat(64)],
      imageCount: 2,
    },
  );

  assert.deepEqual(steps, ['create-release-image']);
});

test('missing release_image links are detected by count', () => {
  const steps = planSeedSteps(
    { ...completeState, existingReleaseImageIds: [] },
    { serviceNames: ['core'], imageHashes: ['sha256:' + 'a'.repeat(64)], imageCount: 1 },
  );

  assert.deepEqual(steps, ['create-release-image']);
});

test('repo names are extracted from balenaCloud image locations', () => {
  assert.equal(
    repoFromLocation('registry2.balena-cloud.com/v2/830e5bb7294e5583620451186e08b5de'),
    '830e5bb7294e5583620451186e08b5de',
  );
  assert.throws(() => repoFromLocation('example.com/some/repo'));
});

test('bulk aggregation counts updated and rejected devices', () => {
  const results: DeviceUpdateResult[] = [
    { id: 1, ok: true },
    { id: 2, ok: false, message: 'Attempt to downgrade supervisor, which is not allowed' },
    { id: 3, ok: true },
  ];

  assert.deepEqual(aggregateResults(results), { total: 3, updated: 2, rejected: 1 });
  assert.deepEqual(aggregateResults([]), { total: 0, updated: 0, rejected: 0 });
});

test('downgrade pre-filter marks versions older than the current one', () => {
  assert.equal(isDowngrade('19.0.8', '19.0.9'), true);
  assert.equal(isDowngrade('19.0.9', '19.0.9'), false);
  assert.equal(isDowngrade('19.0.10', '19.0.9'), false);
  assert.equal(isDowngrade('20.0.0', '19.0.9'), false);
  assert.equal(isDowngrade('19.0.9', null), false);
  assert.equal(isDowngrade('19.0.9', undefined), false);
});

test('raw-version suffixes compare equal to their semver', () => {
  assert.equal(isDowngrade('19.0.9', '19.0.9-1786970539365'), false);
  assert.equal(isSameSupervisorVersion('19.0.9', '19.0.9-1786970539365'), true);
  assert.equal(isSameSupervisorVersion('19.0.9', '19.0.10'), false);
  assert.equal(isSameSupervisorVersion('19.0.9', null), false);
});
