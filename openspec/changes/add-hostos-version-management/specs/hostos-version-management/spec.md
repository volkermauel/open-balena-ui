# HostOS Version Import — spec delta

## ADDED Requirements

### Requirement: HostOS version listing

The system SHALL list hostOS versions available in the configured ghcr mirror for a device type, ordered
newest-first, annotated with whether each version is already imported into the instance.

#### Scenario: List versions for a device type

- **WHEN** an authenticated client requests `GET /hostos-releases/versions?deviceType=<slug>`
- **THEN** the response contains the mirror's versions for that device type's machine, ordered
    version-descending, each marked `seeded` or not

#### Scenario: Mirror unavailable

- **WHEN** the ghcr mirror cannot be reached
- **THEN** the endpoint responds with a non-success status identifying the upstream failure

#### Scenario: Unknown device type

- **WHEN** the device type does not exist on the instance
- **THEN** the endpoint responds with 404

### Requirement: HostOS release import

The system SHALL idempotently import a hostOS version into the instance on request: image row with the
instance-registry location, release on the device type's hostapp application, and the `release_image` link — created
in an order that never exposes a release referencing un-mirrored image bytes. Image bytes are copied byte-identically
by digest from the ghcr mirror into the instance registry.

#### Scenario: Import a version

- **WHEN** an authenticated client requests `POST /hostos-releases/seed {deviceType, version}`
- **THEN** the image is mirrored into the instance registry, and a release (status success, semver fields from the
    version tag) is created or reused on the device type's hostapp app, linked to the image

#### Scenario: Re-import is a no-op

- **WHEN** the version was already imported (release exists and the manifest verifies at the target registry)
- **THEN** no registry bytes are copied and the existing release id is returned

#### Scenario: Crash mid-import

- **WHEN** the process dies during mirroring
- **THEN** no release row exists pointing at un-mirrored bytes (release creation follows verified mirroring)

### Requirement: Registry mirror generalization

The registry mirroring module SHALL support ghcr as a source with anonymous pull tokens, in addition to the existing
balenaCloud source with its server-level token; the supervisor feature's behavior remains unchanged.

#### Scenario: Anonymous source

- **WHEN** mirroring from a source configured without credentials
- **THEN** pulls use the registry's anonymous token endpoint and no credential is required or sent

### Requirement: Import management UI

The webui SHALL present the available hostOS versions for a device type with their import state and an action to
import a version; imported versions become selectable in the existing Target-OS selector without further UI changes.

#### Scenario: Import from the UI

- **WHEN** an authenticated user triggers Import on a listed version
- **THEN** the request runs and the version's state updates when the import completes

#### Scenario: Version appears in Target-OS

- **WHEN** a version has been imported for a device's device type
- **THEN** the built-in Target-OS selector lists it as a targetable OS version
