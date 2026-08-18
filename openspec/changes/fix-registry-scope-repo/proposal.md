## Summary

HostOS imports (and any seed whose image the instance API assigns a single-segment repository name) died at the first
registry request with `Target manifest existence check … failed (401)`.

## Why

The instance API's registry-token endpoint (open-balena-api `SCOPE_PARSE_REGEX`) only grants scopes whose repository
name has more than one path segment — `repository:<bare-32-hex>:pull,push` is silently dropped and the token is minted
with `access: []`, which the registry answers with 401. Verified live: decoding the minted token shows `access: []`, and
the regex drops bare names while accepting `v2/<name>`.

Docker derives the repository name from an image location as everything after the registry host — for location
`<host>/v2/<hash>` that is `v2/<hash>` (exactly how builder pushes land on `/v2/v2/<hash>/…`). Our mirror instead used
the part after `/v2/` (bare `<hash>`), a name no token scope can ever grant — and which also mismatches the path devices
pull from.

## What Changes

- `repoFromLocation` now returns the location minus the registry host — `v2/<name>` — so token scopes
  (`repository:v2/<name>:pull,push`) parse, `resolveImageId`'s `$endswith` matches, and mirror/verify registry paths
  become `/v2/v2/<name>/…`, identical to the builder convention and to what devices request when pulling the image.
- HostOS seed's fallback repo carries the `v2/` prefix too.

## Impact

Supervisor + hostOS seeds, tests. Existing mirrored bytes sit under the old bare-name repos; re-imports re-push into
`v2/<name>` (blob store is content-addressed, so this is cheap and safe).
