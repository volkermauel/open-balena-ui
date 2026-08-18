# fix-image-size — spec deltas

## ADDED Requirements

### Requirement: Seeded images record their size

Every image row created (or adopted) by the supervisor and hostOS seed flows SHALL carry `image_size` — the total
compressed size (config + layers, manifest-list children included) in bytes declared by the image's manifests at the
source registry. A seed run SHALL backfill the size of an already-imported image whose `image_size` is still NULL,
without performing any other writes.

#### Scenario: Cold import

- **WHEN** a hostOS version is imported
- **THEN** the image row carries a positive `image_size` after mirroring verifies, and the Images view renders the size
  in mb instead of 0mb

#### Scenario: Backfill

- **WHEN** a seed runs for a version whose image was imported before this requirement (size NULL, bytes verified)
- **THEN** the only instance write is the `image_size` PATCH
