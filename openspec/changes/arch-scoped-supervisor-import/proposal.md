## Summary

The supervisor version import becomes an architecture-scoped operation with its own surface, and the device-page update
dialog only pins already-imported versions.

## Why

The supervisor depends only on the device's CPU architecture, never on its make/model — yet the import was presented per
device type (the device-page update dialog took a device type slug, showed "Device type <slug>", and mirrored ~150 MB
implicitly on first apply). Internally the scoping was already correct: one supervisor application
(`balena_os/<arch>-supervisor`) and one target registry repo (`<arch>-supervisor`) per arch, per-arch seed locks. The UI
and routes leaked the device-type framing.

## What Changes

- New `GET /supervisor-releases/arches` (distinct arch slugs across device types) and arch-keyed parameters:
  `/versions?arch=`, `/seed { arch, version }` (deviceType variants remain, arch is canonical).
- New **Supervisor Versions** dialog on the Device Types page toolbar (list-level, not a per-row action): arch picker
  (defaults to `aarch64` when present), version list with imported/available state, explicit idempotent Import.
- `seedSupervisorReleaseForArch` extracted as the arch-keyed seed; the device-type entry point resolves the arch and
  delegates.
- The device update flow (`/update`, `updateSupervisorReleases`) no longer seeds: it pins an existing release of the
  arch's supervisor application and refuses unimported versions with guidance to the Supervisor Versions surface.
- The device-page dialog shows `Architecture <arch>` (not the device type), lists only imported versions, and its
  applying state says just "Applying update to devices…".

## Impact

Supervisor routes/controllers, Device Types page toolbar, both supervisor dialogs. No schema changes — the per-arch
application/repo layout is unchanged. Users must import a supervisor version once (per arch) before it can be pinned on
devices.
