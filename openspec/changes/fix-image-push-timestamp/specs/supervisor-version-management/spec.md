# fix-image-push-timestamp — spec delta (supervisor)

## MODIFIED Requirements

### Requirement: Supervisor release seeding

The ui server SHALL seed a supervisor version by creating the instance release/service/image rows and mirroring the
image bytes digest-preserving into the instance registry. Every created image row SHALL carry `status: 'success'`
together with both `start_timestamp` and `push_timestamp`, so that open-balena-api's release validation accepts it.

#### Scenario: Seed a version

- **WHEN** a client seeds a supervisor version
- **THEN** every image row created for it includes `status: 'success'`, `start_timestamp`, and `push_timestamp`, and the
  release creation succeeds against the instance API
