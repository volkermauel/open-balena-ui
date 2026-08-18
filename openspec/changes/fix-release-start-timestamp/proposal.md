## Summary

Release creation POSTs (`createRelease`, `createHostosRelease`) omit `start_timestamp`, which the instance database
requires (NOT NULL). Live hostOS import fails with
`DatabaseError: null value in column "start timestamp" of relation "release" violates not-null constraint` → "Instance
create of release failed (500)".

## Why

The defect was masked until now: the old seed order always aborted at the registry 401 before reaching release creation.
Verified in the open-balena-api pod logs; balena-cli release POSTs (which send `start_timestamp`) succeed against the
same instance.

## What Changes

- Both release creators post `start_timestamp: <ISO now>`, matching the image creator.

## Impact

- `server/controller/{hostosRelease,supervisorRelease}/instance.ts`, two test assertions.
