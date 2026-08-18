# fix-seeded-gate-v7-device — hostOS spec deltas

## ADDED Requirements

### Requirement: Imported marker requires the version tag

The hostOS versions listing SHALL mark a version as imported only when the matching release exists **and** carries its
`version` release tag (the seed's final step). A release row without the tag SHALL leave the version importable so the
idempotent seed can resume the remaining steps.

#### Scenario: Crashed import is resumable from the dialog

- **WHEN** a previous import created the release row but died before mirroring, sizing or tagging
- **THEN** the dialog lists that version as available (not imported), selecting it runs the seed, and only the missing
  steps execute
