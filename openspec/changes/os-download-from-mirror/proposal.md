## Summary

The "Download OS" wizard sources versions, images, and fleet defaults from the operator's own mirror
(`volkermauel/balena-raspberrypi-abrp` GitHub releases) instead of balenaCloud, and the provisioned config gains a
default poll interval and optional gateway SSH keys. Additionally the hostOS/supervisor seeding push_timestamp defect is
fixed (separate change `fix-image-push-timestamp`, same branch).

## Why

- balenaCloud's image catalog lists versions the mirror does not serve — picking them can never produce an image. Only
  mirror-served versions are actionable.
- The fleet dropdown in the wizard loads empty on openBalena (unsupported `is of-class` filter) and ignores the fleet
  the wizard was opened from.
- Devices should poll for app updates every 10 minutes by default.
- Devices behind a gateway must allow the gateway's SSH key in every provisioned image.

## What Changes

- **Version list**: versions come from the mirror repo's GitHub releases that carry a
  `balenaos-<version>-<machine>.img.zip` asset for the device type (machine = device type slug). New env
  `OS_IMAGE_SOURCE_REPO` (default `volkermauel/balena-raspberrypi-abrp`). balenaCloud's image catalog is no longer
  consulted.
- **Download**: the release asset is downloaded (anonymous), verified against the release's `SHA256SUMS` entry,
  unzipped, injected, recompressed. Cache keying unchanged (variant is always `production`).
- **Variant**: selector removed — the mirror publishes production images only.
- **Fleet selection**: the wizard opens with the launching fleet selected and present in the dropdown even before the
  list loads; the dropdown lists fleets of the currently selected device type (client-side filter on
  `is for-device type`); the broken `is of-class` filter is removed.
- **Poll interval**: `appUpdatePollInterval` defaults to `10` (minutes) when the request omits it.
- **Gateway SSH keys**: new env `GATEWAY_SSH_PUBLIC_KEYS` — newline-separated public keys; when set, each provisioned
  config.json gets them in `os.sshKeys`.

## Impact

- Server: `server/controller/osImage/{versions.ts,prepareJob.ts,config.ts,cacheStore.ts,errors.ts}`,
  `server/routes/osImage.ts`
- UI: `src/ui/OsDownloadDialog.tsx`, `src/ui/FleetDownloadOsButton.tsx`
- Docs/tests: README env section, `tests/osImage/*`
