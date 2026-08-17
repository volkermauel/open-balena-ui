# OS Image Downloader — spec delta

## ADDED Requirements

### Requirement: Version listing

The system SHALL list available balenaOS versions for a given device type slug, sourced from balenaCloud's public release catalog, deduplicated and ordered newest-first.

#### Scenario: List versions for a device type

- **WHEN** an authenticated client requests `GET /os-images/versions?deviceType=<slug>`
- **THEN** the response contains the unique `raw_version` values for final, successful host releases of that device type, ordered semver-descending

#### Scenario: Upstream unavailable

- **WHEN** balenaCloud cannot be reached or returns an error
- **THEN** the endpoint responds with a non-success status and a message identifying the upstream failure

### Requirement: Image variant selection

The system SHALL support both production and development image variants, mapping them to balenaCloud's `developmentMode` download parameter.

#### Scenario: Development variant requested

- **WHEN** a prepare job is started with variant `development`
- **THEN** the pristine image is fetched with `developmentMode=true`

#### Scenario: Development image unavailable

- **WHEN** balenaCloud has no development image for the requested device type/version
- **THEN** the job fails with an error message that names the device type and version

### Requirement: Fleet configuration generation

The system SHALL generate the fleet provisioning `config.json` by calling openBalena's `POST /download-config` with the requesting user's own JWT and the selected fleet, version, network, and provisioning options.

#### Scenario: Config generated with user JWT

- **WHEN** a prepare job runs for a fleet
- **THEN** the server forwards the caller's `Authorization` header to openBalena's `/download-config` with the fleet's application id and selected options, and injects the returned JSON into the image

#### Scenario: Config generation unauthorized

- **WHEN** openBalena rejects the forwarded JWT
- **THEN** the job fails with an authentication error surfaced to the client

### Requirement: Config injection

The system SHALL inject the generated `config.json` into the boot partition of the uncompressed image before compression, using the same mechanism as `balena os configure`.

#### Scenario: Injected image boots into the fleet

- **WHEN** the artifact is flashed to a device and booted
- **THEN** the device provisions into the selected fleet, because `config.json` is present on the image's boot partition

### Requirement: Compressed artifact download

The system SHALL deliver provisioned images as `.zip` or `.gz` archives containing the injected image, streamed to the browser with an appropriate download filename.

#### Scenario: Download artifact

- **WHEN** a job has reached `ready` state and the client requests `GET /os-images/jobs/:id/download`
- **THEN** the response streams the archive with `Content-Disposition: attachment` naming device type, version, variant, and fleet

### Requirement: Pristine image cache

The system SHALL download each pristine (unconfigured) image from balenaCloud at most once per (device type, version, variant), storing it in the cache directory and reusing it for subsequent prepares.

#### Scenario: Second download is served from cache

- **WHEN** two prepare jobs request the same pristine image
- **THEN** balenaCloud is contacted only once and both jobs use the same cached file

### Requirement: Configured artifact cache

The system SHALL cache compressed, provisioned artifacts keyed by device type, version, variant, config hash, and format, and reuse them when an identical configuration is prepared again.

#### Scenario: Identical config reuses artifact

- **WHEN** a prepare job's (device type, version, variant, config, format) tuple already exists in the cache
- **THEN** the job completes without downloading, injecting, or compressing again

### Requirement: Cache size enforcement

The system SHALL bound total cache disk usage with an LRU eviction policy and a configurable cap (`OS_IMAGE_CACHE_MAX_GB`, default 20 GB), and SHALL never evict files in use by running jobs.

#### Scenario: Cap exceeded

- **WHEN** writing a new cache file would push total cache bytes above the cap
- **THEN** least-recently-used files are evicted until the cap is satisfied

### Requirement: Cache status reporting

The system SHALL report which versions per device type and variant are present in the cache, so the UI can indicate cached entries.

#### Scenario: Cached badge in version dropdown

- **WHEN** the version dropdown is rendered for a device type
- **THEN** versions whose pristine image or any configured artifact is cached display a cached indicator

### Requirement: Preparation job lifecycle

The system SHALL expose an asynchronous prepare job with a stable identifier and observable phases (`downloading`, `injecting`, `compressing`, `ready`, `error`), including byte progress during download when the upstream size is known.

#### Scenario: Poll job to ready

- **WHEN** a client polls `GET /os-images/jobs/:id`
- **THEN** the response reports the current phase and progress until it reaches `ready` or `error`

### Requirement: Authentication

All OS image endpoints SHALL require a valid UI JWT and SHALL be rate/dos protected, consistent with existing server routes.

#### Scenario: Missing token

- **WHEN** any `/os-images/*` endpoint is called without a valid `Authorization: Bearer` header
- **THEN** the endpoint responds 401

### Requirement: Fleet entry point

The UI SHALL offer a "Download OS" action on fleets that opens the provisioning wizard with the fleet and its device type preselected.

#### Scenario: Launch from fleet

- **WHEN** the user triggers "Download OS" on a fleet
- **THEN** the wizard opens with that fleet selected and its device type chosen
