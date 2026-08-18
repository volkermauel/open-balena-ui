# fix-release-start-timestamp — spec deltas

## MODIFIED Requirements

### Requirement: HostOS version seeding

Every created release row SHALL carry `start_timestamp` alongside `status: 'success'`, so the
instance database's NOT NULL constraint on `release.start_timestamp` is satisfied.

#### Scenario: Seed a version

- **WHEN** a client seeds a hostOS version
- **THEN** the created release row includes `start_timestamp` and the instance API accepts the
  creation

## MODIFIED Requirements

### Requirement: Supervisor release seeding

Every created release row SHALL carry `start_timestamp` alongside `status: 'success'`.

#### Scenario: Seed a version

- **WHEN** a client seeds a supervisor version
- **THEN** the created release row includes `start_timestamp` and the instance API accepts the
  creation
