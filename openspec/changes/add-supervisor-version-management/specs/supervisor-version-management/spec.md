# Supervisor Version Management — spec delta

## ADDED Requirements

### Requirement: Supervisor version listing

The system SHALL list available supervisor versions for a device type, sourced from balenaCloud's public supervisor
catalog for the device type's CPU architecture, deduplicated and ordered newest-first, annotated with whether each
version is already seeded into the instance.

#### Scenario: List versions for a device type

- **WHEN** an authenticated client requests `GET /supervisor-releases/versions?deviceType=<slug>`
- **THEN** the response contains unique supervisor versions for that device type's architecture, ordered
  semver-descending, each marked `seeded` or not

#### Scenario: Upstream unavailable

- **WHEN** balenaCloud cannot be reached
- **THEN** the endpoint responds with a non-success status identifying the upstream failure

### Requirement: Supervisor release seeding

The system SHALL idempotently seed a supervisor version into the openBalena instance on request: public supervisor
application, services, images (instance-registry locations), mirrored image bytes, and the release with `release_image`
links — created in an order that never exposes a release referencing un-mirrored images.

#### Scenario: Seed a version

- **WHEN** an authenticated client requests `POST /supervisor-releases/seed {deviceType, version}`
- **THEN** the supervisor app, services, images, mirrored bytes, and release exist in the instance, and the response
  reports the instance release id

#### Scenario: Re-seed is a no-op

- **WHEN** the same version is seeded again
- **THEN** existing rows are reused, no duplicate rows or image copies are created

#### Scenario: Mirroring not configured

- **WHEN** `BALENACLOUD_TOKEN` is not set on the server
- **THEN** seeding fails with a clear "mirroring not configured" error while version listing continues to work

### Requirement: Image mirroring

The system SHALL copy supervisor image manifests byte-identically (by digest) with all referenced blobs from
balenaCloud's registry into the instance registry, skipping blobs that already exist, using the balenaCloud token for
pulls and the caller's instance JWT for pushes.

#### Scenario: Digest preservation

- **WHEN** an image is mirrored
- **THEN** pulling the manifest by its balenaCloud digest from the instance registry yields the byte-identical manifest,
  so seeded `content_hash` values remain valid

#### Scenario: Existing blobs are not re-copied

- **WHEN** a blob referenced by a manifest already exists in the target registry
- **THEN** the mirror step skips that blob

### Requirement: Device supervisor target update

The system SHALL set a device's target supervisor release via `PATCH device "should be managed by-release"` using the
requesting user's JWT, for one or many devices, and SHALL report per-device results.

#### Scenario: Update one device

- **WHEN** a client requests `POST /supervisor-releases/update` with a single device id and a seeded version
- **THEN** the device's target supervisor release is set to that version's instance release

#### Scenario: Downgrade rejected by the API is surfaced

- **WHEN** the target version is older than a device's current supervisor
- **THEN** that device's result is `rejected` with the API's error message, and other devices in the same request are
  unaffected

#### Scenario: Fleet bulk update

- **WHEN** the action is invoked for multiple devices of a fleet
- **THEN** devices are updated per device type and a summary of updated/rejected devices is returned

### Requirement: Supervisor status

The system SHALL report a device's current supervisor version and target (pending) supervisor release.

#### Scenario: Pending target visible

- **WHEN** a device has a target supervisor release set that differs from its reported version
- **THEN** the status endpoint and the device page show the pending target version

### Requirement: Authentication

All supervisor-release endpoints SHALL require a valid UI JWT and be dos-protected, consistent with existing server
routes; instance writes SHALL be performed with the caller's own JWT.

#### Scenario: Missing token

- **WHEN** any `/supervisor-releases/*` endpoint is called without a valid `Authorization: Bearer` header
- **THEN** the endpoint responds 401

### Requirement: UI entry points

The UI SHALL offer supervisor updates from the device page (single device, preselected version list) and as bulk actions
for selected devices and for a whole fleet.

#### Scenario: Device page update

- **WHEN** the user opens "Update Supervisor" on a device
- **THEN** a dialog lists available versions, marks the current one, disables downgrades, and applies the update on
  confirmation with progress feedback

#### Scenario: Downgrades disabled in the dialog

- **WHEN** a listed version is older than the device's current supervisor version
- **THEN** it is displayed as disabled with a "downgrade not allowed" hint
