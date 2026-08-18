# os-download-from-mirror — spec deltas

## MODIFIED Requirements

### Requirement: Version listing

The system SHALL list available balenaOS versions for a given device type slug, sourced from the
configured OS image mirror's GitHub releases (`OS_IMAGE_SOURCE_REPO`, default
`volkermauel/balena-raspberrypi-abrp`), limited to releases that carry a
`balenaos-<version>-<machine>.img.zip` asset for that device type (machine = device type slug),
deduplicated and ordered newest-first. balenaCloud SHALL NOT be consulted.

#### Scenario: List versions for a device type

- **WHEN** an authenticated client requests `GET /os-images/versions?deviceType=<slug>`
- **THEN** the response contains the versions of mirror releases that carry a
  `balenaos-<version>-<slug>.img.zip` asset, ordered semver-descending

#### Scenario: Device type not on the mirror

- **WHEN** no mirror release carries an asset for the requested device type
- **THEN** the response contains an empty list

#### Scenario: Upstream unavailable

- **WHEN** the GitHub releases API cannot be reached or returns an error
- **THEN** the endpoint responds with a non-success status and a message identifying the upstream failure

## REMOVED Requirements

### Requirement: Image variant selection

**Reason:** the mirror publishes production images only; the variant option disappears from the
wizard and the API accepts `production` exclusively.

## ADDED Requirements

### Requirement: Production-only variant

The system SHALL provision production images only: prepare requests with any variant other than
`production` are rejected, and the wizard no longer offers a variant choice.

#### Scenario: Development variant rejected

- **WHEN** a prepare job is started with variant `development`
- **THEN** the request is rejected with a non-success status naming the accepted value

### Requirement: Mirror asset integrity verification

The system SHALL verify each downloaded mirror asset against the release's `SHA256SUMS` entry
before using it, and SHALL fail closed when the entry is missing or the hash mismatches.

#### Scenario: Verified download

- **WHEN** a pristine image is downloaded for a device type and version
- **THEN** its sha256 matches the `SHA256SUMS` entry for the asset name before the artifact is
  unpacked or cached as verified

#### Scenario: Missing checksum fails

- **WHEN** the mirror release has no `SHA256SUMS` asset or no entry for the image asset
- **THEN** the job fails with an error naming the missing checksum, and the unverified bytes are
  not cached as pristine

## MODIFIED Requirements

### Requirement: Fleet configuration generation

The system SHALL generate the fleet provisioning `config.json` by calling openBalena's
`POST /download-config` with the requesting user's own JWT and the selected fleet, version,
network, and provisioning options, with `appUpdatePollInterval` defaulting to `10` (minutes) when
the request omits it. When `GATEWAY_SSH_PUBLIC_KEYS` is configured on the server (newline-separated
public keys), the generated config SHALL additionally carry those keys in `os.sshKeys` before the
config is injected into the image.

#### Scenario: Config generated with user JWT

- **WHEN** a prepare job runs for a fleet
- **THEN** the server forwards the caller's `Authorization` header to openBalena's
  `/download-config` with the fleet's application id, `appUpdatePollInterval: 10` (unless the
  request specifies one), and the selected options, and injects the returned JSON into the image

#### Scenario: Gateway keys injected

- **WHEN** `GATEWAY_SSH_PUBLIC_KEYS` contains one or more valid public keys and a prepare job runs
- **THEN** the injected config.json contains all of them in `os.sshKeys`

#### Scenario: Gateway keys unconfigured

- **WHEN** `GATEWAY_SSH_PUBLIC_KEYS` is unset or empty
- **THEN** the injected config.json contains no `os.sshKeys` entry added by this feature

## MODIFIED Requirements

### Requirement: Fleet entry point

The UI SHALL offer a "Download OS" action on fleets that opens the provisioning wizard with the
fleet selected and present in the fleet dropdown immediately, its device type chosen, and the
fleet dropdown listing the fleets of the currently selected device type.

#### Scenario: Launch from fleet

- **WHEN** the user triggers "Download OS" on a fleet
- **THEN** the wizard opens with that fleet selected and visible in the dropdown, and its device
  type chosen

#### Scenario: Fleet list resilient to API filter gaps

- **WHEN** the application list request fails or returns no additional fleets
- **THEN** the launching fleet remains selected and selectable in the dropdown
