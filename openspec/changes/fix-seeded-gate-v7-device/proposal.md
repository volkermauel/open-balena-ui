## Summary

Two live bugs from the same diagnosis: a half-imported hostOS version could never be re-imported, and every device page
fired a 500 at the instance API.

## Why

- The hostOS versions listing marked a version `seeded` as soon as a matching release row existed. Release rows are
  created _before_ mirroring (link-before-mirror), so a crashed import (rows but no bytes, no image size, no `version`
  tag) was shown as "imported" and the import button stayed disabled — the user could not resume it.
- The supervisor state read/target patch queried `/v6/device` selecting `should_be_managed_by__release`. That fact type
  exists only in the instance API's v7 translation; v6 answers 500
  `Could not resolve relationship mapping from 'device' to 'should be managed by,release'` (17×/4h in the live logs).
  `supervisor_version` and the release version fields exist on both versions.

## What Changes

- `seeded` now requires the release row **and** its `version` release tag — the tag is the seed's last step, so tag
  presence means fully imported. Half-imported versions stay selectable; re-importing resumes idempotently (mirror →
  size → tag).
- Device supervisor queries (state read + managed-by PATCH) move to `/v7/device`.

## Impact

hostOS + supervisor controllers, their tests; no schema or data changes (no DB cleanup needed for the stuck
7.4.0+rev6/raspberrypi4-64 import — it resumes via the dialog).
