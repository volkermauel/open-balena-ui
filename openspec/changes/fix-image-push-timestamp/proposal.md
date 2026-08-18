## Summary

Image creation posts `status: 'success'` without `push_timestamp`; open-balena-api rejects the
release ("It is necessary that each image that has a status that is equal to 'success', has a push
timestamp."). Both the supervisor and the hostOS seeding flows are affected.

## Why

Live hostOS import of `7.4.0+rev5` fails with exactly that error. `createImage` sets
`start_timestamp` but never `push_timestamp`.

## What Changes

- `createImage` (shared by both seed controllers) additionally posts `push_timestamp: <ISO now>`.

## Impact

- `server/controller/supervisorRelease/instance.ts` (one payload line), tests asserting the payload.
