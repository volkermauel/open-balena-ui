# arch-scoped-supervisor-import — spec deltas

## ADDED Requirements

### Requirement: Supervisor import is architecture-scoped

Importing a supervisor version SHALL be keyed by CPU architecture: one supervisor application and one target registry
repo exist per arch, and the import surface SHALL be a list-level action on the Device Types page with an arch picker —
never a per-device-type row action.

#### Scenario: Importing a version for an architecture

- **WHEN** a user opens Supervisor Versions on the Device Types page and imports a version for an architecture
- **THEN** the version is seeded once for that arch (idempotent re-imports do nothing) and becomes pin-able for every
  device type of that architecture

### Requirement: Device updates pin imported versions only

The device supervisor update flow SHALL NOT mirror image bytes. It SHALL pin a release that already exists on the arch's
supervisor application and SHALL refuse versions that are not imported, with guidance to the Supervisor Versions
surface.

#### Scenario: Pinning an unimported version

- **WHEN** a supervisor update is requested for a version with no matching release on the arch's supervisor application
- **THEN** the request fails with a not-found error naming the architecture and the import surface, and no registry
  request is made
