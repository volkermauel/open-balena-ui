# OS download from the operator mirror

## Context

The OS-image downloader currently lists versions from balenaCloud's public image catalog and downloads uncompressed
images from balenaCloud's image endpoint. The operator's mirror (`volkermauel/balena-raspberrypi-abrp`) publishes
self-built balenaOS images as GitHub release assets — `balenaos-<version>-<machine>.img.zip` plus a `SHA256SUMS` file
per release — where `<machine>` equals the device type slug (verified: `v7.4.0+rev5` serves `raspberrypi4-64` and
`raspberry5` assets). Fleet applications on the instance reference device types via `is for-device type`; openBalena's
OData does not support the `is of-class` filter the dialog uses.

## Goals / Non-Goals

- Goals: version list = exactly what the mirror serves for the device type; verified downloads; wizard pre-filled from
  the launching fleet; token-free operation; config defaults (poll 10 min, gateway SSH keys) without dialog complexity.
- Non-Goals: dev-variant images; uploading images to the instance registry (devices are flashed); multi-mirror
  aggregation.

## Decisions

- **Releases API as catalog.** `GET https://api.github.com/repos/<OS_IMAGE_SOURCE_REPO>/releases` (anonymous,
  `per_page=100`, paginate while links remain). A release contributes a version for device type `<dt>` iff an asset
  matches `^balenaos-(?<v>.+)-<dt>\.img\.zip$`. Version order: `balena-semver` desc (its rcompare degrades gracefully on
  odd versions — no separate fallback). The asset's `browser_download_url` is the download source; `SHA256SUMS` (same
  release) maps `<asset name> → sha256`.
- **Pristine cache holds the verified zip.** Download asset → stream to `<cache>/pristine/.../<asset>.zip` →
  sha256-verify against SHA256SUMS → unzip at prepare time → inject → recompress (`zip`/`gz` per request). Verification
  happens once per pristine download, not per fleet artifact.
- **Variant collapses to production.** `OsImageVariant` stays in the cache/request types (existing artifacts keep
  working) but the API only accepts `production` and the radio disappears; a request with `development` is a 406,
  mirroring the existing validation style.
- **Fleet dropdown resilience.** `FleetDownloadOsButton` passes the full record; `OsDownloadDialog` seeds its fleet list
  with that record, selects it, and refines the list when the `application` fetch resolves. The device-type choice
  filters fleets client-side via `is for-device type`. No `is of-class` server filter.
- **Poll default in the route.** `appUpdatePollInterval` unset → `10`. (openBalena's `/download-config` accepts
  `appUpdatePollInterval` in minutes; the ui just defaults it.)
- **SSH keys post-merge.** `GATEWAY_SSH_PUBLIC_KEYS` is split on newlines, trimmed, empties dropped; each key must match
  `^ssh-(rsa|dss|ed25519|ecdsa)-` (config load error otherwise). Keys are merged into `config.os.sshKeys` after
  `generateFleetConfig` returns, before `configJson.write` — the instance API is not involved.

## Risks / Trade-offs

- GitHub API rate limit (60/h anonymous) — cache the releases listing in-process for 5 minutes.
- If a release lacks `SHA256SUMS`, seeding of that version fails closed (error names the missing checksum) rather than
  shipping an unverified image.
- Fleet list shows only fleets matching the selected device type — intentional (provisioning for another device type
  would produce an unbootable image).

## Migration Plan

None — no persisted state. Legacy pristine `.img` artifacts (balenaCloud-sourced) are NOT reused by new downloads: the
pristine cache key is now the `.zip` asset, so preparing such a version re-downloads it from the mirror. Legacy entries
still surface in cache status and age out through LRU eviction — the "cached" badge may therefore show for a version
whose next prepare re-downloads.

## Open Questions

- None.
