# Supervisor ghcr source — spec delta

## MODIFIED Requirements

### Requirement: Supervisor version listing

The ui server SHALL list supervisor versions from the tags of the configured supervisor source registry
(default `ghcr.io/volkermauel/aarch64-supervisor`-style per-arch repositories, anonymous pull), enriched
with balenaCloud public-catalog metadata on a best-effort basis. No balenaCloud credential SHALL be
required for listing or for any other part of the supervisor feature.

#### Scenario: List versions for a device type

- **WHEN** the client requests versions for a device type whose arch is `aarch64`
- **THEN** the server lists every semver-parseable tag of `<owner>/<arch>-supervisor` on the source
  registry, newest first, with variant and service metadata from the balenaCloud catalog when the version
  is known there and defaults otherwise

#### Scenario: Arch without a mirror repository

- **WHEN** the arch's mirror repository has no tags (or does not exist)
- **THEN** the server returns an empty list rather than an error

#### Scenario: Enrichment unavailable

- **WHEN** the balenaCloud catalog cannot be reached while the mirror is reachable
- **THEN** the server still lists the mirror tags with default metadata

#### Scenario: Mirror unavailable

- **WHEN** the source registry cannot be reached
- **THEN** the server responds with a 502-style upstream error naming the source registry

## MODIFIED Requirements

### Requirement: Supervisor release seeding

The ui server SHALL seed a supervisor version by resolving the version tag's manifest digest on the
source registry, creating the instance release/service/image rows with that digest as the image content
hash, and mirroring the bytes digest-preserving into the instance registry. The digest SHALL come from
the source registry's manifest response (`Docker-Content-Digest`, or the sha256 of the manifest body as
a fallback) — never from balenaCloud.

#### Scenario: Seed a version

- **WHEN** a client seeds version `19.0.8` for arch `aarch64` and the mirror has tag `v19.0.8`
- **THEN** the server resolves that tag's digest, mirrors the image into the instance registry under the
  image row's assigned location, and creates a release the device target can point at

#### Scenario: Tag missing on the mirror

- **WHEN** the requested version has no `v<version>` or `<version>` tag on the mirror repository
- **THEN** seeding fails with a clear not-found error stating the version must be built and published by
  the mirror repository's supervisor workflow

#### Scenario: Re-seed is a no-op

- **WHEN** the version's release and fully-mirrored image already exist on the instance
- **THEN** seeding returns the existing release without re-copying blobs

## REMOVED Requirements

### Requirement: Authentication (missing `BALENACLOUD_TOKEN` scenario)

**Reason:** supervisor sourcing is anonymous (ghcr mirror); no balenaCloud credential exists to check.
The instance JWT requirement for the routes themselves is unchanged and covered by the existing route
authentication behavior.
