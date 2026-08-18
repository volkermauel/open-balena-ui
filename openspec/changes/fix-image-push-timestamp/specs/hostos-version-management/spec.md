# fix-image-push-timestamp — spec delta (hostos)

## MODIFIED Requirements

### Requirement: HostOS version seeding

The ui server SHALL seed a hostOS version by creating the instance release/image rows and mirroring the hostapp image
bytes digest-preserving into the instance registry. Every created image row SHALL carry `status: 'success'` together
with both `start_timestamp` and `push_timestamp`, so that open-balena-api's release validation accepts it.

#### Scenario: Seed a version

- **WHEN** a client seeds hostOS version `7.4.0+rev5` for machine `raspberrypi5`
- **THEN** the created image row includes `status: 'success'`, `start_timestamp`, and `push_timestamp`, and the import
  succeeds against the instance API
