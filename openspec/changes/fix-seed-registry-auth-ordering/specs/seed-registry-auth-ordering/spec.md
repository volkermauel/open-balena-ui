# fix-seed-registry-auth-ordering — spec deltas

## MODIFIED Requirements

### Requirement: HostOS version seeding

The ui server SHALL seed a hostOS version by creating the instance image row, the release, and the release-image link
BEFORE mirroring the hostapp image bytes into the instance registry, because the instance API's registry-token endpoint
grants `pull` on a repository only once its image is linked to a release. Every created image row SHALL carry
`status: 'success'` together with both `start_timestamp` and `push_timestamp`.

#### Scenario: Seed a version

- **WHEN** a client seeds hostOS version `7.4.0+rev5` for machine `raspberrypi5`
- **THEN** the release row and its release-image link exist before the first registry write, and the mirroring token
  therefore carries both `pull` and `push` for the hook-assigned repository

#### Scenario: Mirror read-back succeeds

- **WHEN** the mirrored bytes are verified with a manifest HEAD against the instance registry
- **THEN** the registry answers 200/404 (not 401), because the image is already linked to a readable application's
  release

## MODIFIED Requirements

### Requirement: Supervisor release seeding

The ui server SHALL seed a supervisor version by creating the instance release/service/image rows and the release-image
links BEFORE mirroring the image bytes into the instance registry (same registry-token pull requirement as the hostOS
flow).

#### Scenario: Seed a version

- **WHEN** a client seeds a supervisor version
- **THEN** every release-image link exists before the first registry write, and the mirroring token therefore carries
  both `pull` and `push` for the hook-assigned repository
