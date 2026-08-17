## Why

openBalena has no supervisor-update capability at all: instances ship zero supervisor releases (no `balena_os/<arch>-supervisor` apps), so supervisors stay frozen at the version baked into the flashed OS image. Updating a device's supervisor today is impossible from the webui — the API machinery (`should be managed by-release` + no-downgrade hooks + state v3 delivery) exists but there is nothing to point it at. We want a one-click "update supervisor to version X" from the device (or fleet) page, including making the selected supervisor version actually available to devices. Tracked in volkermauel/open-balena-ui#2.

## What Changes

- New capability `supervisor-version-management`:
  - New authenticated UI-server routes that list supervisor versions for a device type (balenaCloud public catalog, merged with instance state), seed a version into the instance (metadata via the caller's JWT + byte-identical image mirroring from balenaCloud's registry into the instance registry using `BALENACLOUD_TOKEN`), and set device targets (`PATCH device "should be managed by-release"`, single or bulk).
  - Device page: Supervisor card gains current/target version display and an "Update Supervisor" dialog (version list, seed progress, downgrade prevention, mirroring-not-configured notice).
  - Bulk "Update Supervisor" action for selected devices and fleet-wide.
- New npm dependency: `balena-semver` (pure JS, supervisor semver ordering).
- New environment variables: `BALENACLOUD_TOKEN`, `OPEN_BALENA_REGISTRY_URL` (default derived from the API URL host).
- New `npm test` script running `node:test` unit tests via `tsx` (mirrors the OS-image change if not already present).

## Capability

- New capability: `supervisor-version-management` (spec delta in `specs/supervisor-version-management/spec.md`)
