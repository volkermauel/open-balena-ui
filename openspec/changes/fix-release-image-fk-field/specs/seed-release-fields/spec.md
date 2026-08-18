# fix-release-image-fk-field — spec deltas

## MODIFIED Requirements

### Requirement: HostOS version seeding

The release-image link SHALL be created with the `is_part_of__release` field (not `release`), so
the instance database's NOT NULL FK column is populated.

#### Scenario: Link the image

- **WHEN** a seeded image is linked into its release
- **THEN** the release_image POST carries `is_part_of__release` and `image`, and the instance API
  accepts the creation

## MODIFIED Requirements

### Requirement: Supervisor release seeding

The release-image link SHALL be created with the `is_part_of__release` field.

#### Scenario: Link the image

- **WHEN** a seeded image is linked into its release
- **THEN** the release_image POST carries `is_part_of__release` and `image`, and the instance API
  accepts the creation
