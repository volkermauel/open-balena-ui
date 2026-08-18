# fix-seeded-gate-v7-device — supervisor spec deltas

## ADDED Requirements

### Requirement: Device queries use a translation that defines managed-by

Device reads and writes involving `should be managed by release` SHALL address the v7 API translation, which defines the
fact type; v6 lacks it and answers 500.

#### Scenario: Device page supervisor state

- **WHEN** the device page loads and the UI server reads the device's supervisor state
- **THEN** the request targets `/v7/device(...)` and succeeds (no 500 from a v6 relationship-mapping failure)
