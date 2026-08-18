## Summary

Both seeding flows (hostOS import, supervisor seed) mirror image bytes into the instance registry
BEFORE creating the release and its release_image link. The API's registry-token endpoint grants
`pull` on a repository only once its image is linked to a release of an application the caller can
read (`application → owns__release → release_image → image`), so the target-registry token the
seeder obtains carries only `push` and every read-back HEAD/GET fails with 401 ("Target manifest
existence check … failed (401)").

## Why

Live hostOS import of `7.4.0+rev5` fails with exactly that error. Verified against
open-balena-api's `src/features/registry/registry.ts` (`resolveReadAccess`) and pinejs'
`canAccess` (`resin.image.push` ⊂ `resin.image.all`, held by the default user role): push is
always granted for the calling user, pull requires the release link.

## What Changes

- `planHostosSeedSteps` order becomes: create-image-metadata → create-release →
  create-release-image → mirror-bytes → create-release-tag.
- `planSeedSteps` (supervisor) order becomes: create-app → create-service →
  create-image-metadata → create-release → create-release-image → mirror-bytes.
- Crash-safety semantics are unchanged (rows before bytes, idempotent re-entry); the executors
  already follow the plan arrays verbatim.

## Impact

- `server/controller/{hostosRelease,supervisorRelease}/seed.ts`, order-asserting tests.
