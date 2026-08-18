import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planHostosSeedSteps } from '../../server/controller/hostosRelease/seed';

const completeState = {
  appId: 99,
  serviceId: 55,
  imageId: 11,
  releaseId: 42,
  linkedImageIds: [11],
  hasVersionTag: true,
  bytesVerified: true,
};

test('a fully imported version plans no work', () => {
  assert.deepEqual(planHostosSeedSteps(completeState), ['complete']);
});

test('a cold import plans every step in crash-safe order', () => {
  assert.deepEqual(
    planHostosSeedSteps({
      linkedImageIds: [],
      hasVersionTag: false,
      bytesVerified: false,
    }),
    ['create-image-metadata', 'mirror-bytes', 'create-release', 'create-release-image', 'create-release-tag'],
  );
});

test('metadata existing but bytes unverified still mirrors before the release', () => {
  assert.deepEqual(
    planHostosSeedSteps({
      ...completeState,
      releaseId: undefined,
      linkedImageIds: [],
      hasVersionTag: false,
      bytesVerified: false,
    }),
    ['mirror-bytes', 'create-release', 'create-release-image', 'create-release-tag'],
  );
});

test('a crashed import resumes: bytes there, release missing', () => {
  assert.deepEqual(
    planHostosSeedSteps({ ...completeState, releaseId: undefined, linkedImageIds: [], hasVersionTag: false }),
    ['create-release', 'create-release-image', 'create-release-tag'],
  );
});

test('release present but image unlinked finishes the link', () => {
  assert.deepEqual(planHostosSeedSteps({ ...completeState, linkedImageIds: [] }), ['create-release-image']);
});

test('release present without the version tag finishes the tag', () => {
  assert.deepEqual(planHostosSeedSteps({ ...completeState, hasVersionTag: false }), ['create-release-tag']);
});

test('release present but bytes missing re-mirrors (registry wiped)', () => {
  assert.deepEqual(planHostosSeedSteps({ ...completeState, bytesVerified: false }), ['mirror-bytes']);
});
