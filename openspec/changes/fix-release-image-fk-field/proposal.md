## Summary

`createReleaseImage` posts `{ release, image }` to `POST /v6/release_image`, but the resource's release FK field is
`is_part_of__release` (DB column `is part of-release`, NOT NULL). The API silently drops the unknown `release` field and
the insert fails with
`DatabaseError: null value in column "is part of-release" of relation "image-is part of-release" violates not-null constraint`
→ "Instance create of release_image failed (500)".

## Why

Verified in the api pod logs and the live `resin` DB schema (`image-is part of-release` requires `image` +
`is part of-release`). Our own link-detection GET already navigates `is_part_of__release/any(...)`, and balena-cli posts
the same field name (v7 alias).

## What Changes

- `createReleaseImage` posts `{ is_part_of__release, image }` (shared by supervisor + hostOS flows).

## Impact

- `server/controller/supervisorRelease/instance.ts`, test mocks/assertions.
