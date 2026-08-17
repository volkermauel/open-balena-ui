## Why

Provisioning a device for an openBalena fleet today requires leaving the UI: browse balena.io/os to find a board's balenaOS image, download it, then use the balena CLI (`balena os configure`) to inject the fleet `config.json`. The web UI already holds every piece of data needed (fleets, device types, the user's authenticated session), so it should offer a one-click "download a provisioned OS image" flow. Tracked in volkermauel/open-balena-ui#1.

## What Changes

- New capability `os-image-downloader`:
  - New authenticated UI-server routes that proxy balenaCloud's public version listing and image download endpoints, cache images on disk (pristine images once per device type/version/variant; configured+compressed artifacts per configuration), and manage prepare jobs (download → inject `config.json` → compress → serve).
  - New fleet action "Download OS" opening a wizard dialog: device type (preselected from the fleet), version (with "cached" badges), production/development variant, `.zip`/`.gz` format, fleet config options (network, wifi, poll interval, development mode), then streams the provisioned artifact to the browser.
- New npm dependencies: `balena-image-fs`, `balena-config-json`, `file-disk`, `partitioninfo`, `archiver` (plus types).
- New environment variables: `OS_IMAGE_CACHE_DIR`, `OS_IMAGE_CACHE_MAX_GB`, `BALENACLOUD_API_URL`.
- New `npm test` script running `node:test` unit tests via `tsx`.

## Capability

- New capability: `os-image-downloader` (spec delta in `specs/os-image-downloader/spec.md`)
