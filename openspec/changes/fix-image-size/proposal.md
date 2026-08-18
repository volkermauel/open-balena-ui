## Summary

Seeded images (supervisor and hostOS flows) never set `image_size`, so the Images view renders every imported image as
`0mb` — the column is nullable and our POSTs simply omitted it. balena-cli pushed rows carry the size; ours did not.

## Why

Verified live: the `image` table's `image size` column is NULL for all seeded rows (ids 20, 21, 24, 29–31, 33, 34) while
registry bytes are complete (audited per-repo blob totals in S3: 72–528 MB each, nothing missing). The import is NOT
broken — only the display field was never written.

## What Changes

- New `imageCompressedSize` (registryMirror): sums `config.size + layers[].size` from the source manifests, recursing
  into manifest-list children.
- Both seed planners gain a `set-image-size` step after `mirror-bytes`, planned whenever a row is freshly created or an
  existing row's size is still NULL — so re-running a seed on an already imported (but unsized) version backfills the
  size without any other writes.
- `findImageByContentHash` now selects `image_size`; new `setImageSize` PATCHes it.

## Impact

- `server/controller/supervisorRelease/{registryMirror,instance,seed}.ts`, `server/controller/hostosRelease/seed.ts`,
  planner + imperative tests.
