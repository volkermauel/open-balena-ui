# Design: Supervisor version management

## Context

- openBalena instances ship **no supervisor releases**: there are no `balena_os/<arch>-supervisor` applications, no
  releases, no images (verified on the production instance: `application?$filter=startswith(slug,'balena_os/')` returns
  `[]`). Upstream forums confirm supervisor updates were never wired up in openBalena.
- The delivery machinery **does** exist in open-balena-api:
  - Device field `should be managed by-release` (FK to `release`); `PATCH device` with this field is validated by
    supervisor-app hooks (upgrade-only, semver check, release must be `status=success` with semver > 0, belong to a
    public non-host app whose device type's CPU arch matches).
  - State v3 (`/device/v3/<uuid>/state`) includes `should_be_managed_by__release` as a target release — modern
    supervisors (the instance runs 19.0.8) consume this.
- balenaCloud exposes the supervisor catalog publicly (verified anonymously):
  - App: `GET {BC}/v6/application?$filter=slug eq 'balena_os/<arch>-supervisor'` → id, `is_for__device_type`, uuid;
    `is_public: true`, `is_host: false`, `is_of__class: 'app'`.
  - Releases: `GET {BC}/v6/release?$filter=belongs_to__application eq <id> and status eq 'success'&$orderby=id desc` →
    `semver`, `raw_version`, `composition`, `variant`.
  - `release_image` and `image` (with `is_stored_at__image_location` = `registry2.balena-cloud.com/v2/<32-hex-repo>` and
    `content_hash` = `sha256:…`, plus `is_a_build_of__service` → `service_name`) are publicly readable.
- **Image bytes are the hard part**: balenaCloud's registry rejects anonymous pulls (verified: anonymous
  `/auth/v1/token` token → manifest HEAD `401`). Pulling requires a balenaCloud JWT (any account, e.g. free) via
  `Authorization: Bearer` on the token endpoint. Pushing to the instance registry uses the instance's own
  `/auth/v1/token` with the admin user's JWT — the same flow `balena push` uses.

## Goals

- One click from a device (or fleet) page to a newer supervisor version.
- Supervisor images become available through the instance's own registry (mirrored once per (arch, version)).
- No new authority: all instance writes happen with the logged-in UI user's JWT (admin in openBalena), all balenaCloud
  reads are anonymous, pulls use the server-level `BALENACLOUD_TOKEN`.

## Decisions

### D1: Server-mediated seed + mirror + patch

The browser cannot talk to balenaCloud's registry, and instance writes must be auditable. The UI server (Express,
already JWT-guarded) mediates:

1. **List** — anonymous balenaCloud reads, merged with instance state.
2. **Seed** — idempotently create app/services/images metadata in the instance using the caller's forwarded JWT, then
   mirror image bytes, then create the release + `release_image` links last (never a release referencing un-mirrored
   images).
3. **Update** — PATCH device(s) `should be managed by-release` with the caller's JWT (the API enforces no-downgrade).

### D2: Byte-identical manifest mirroring

Copy manifests as-is (byte-identical, by digest) plus every referenced blob (config + layers, recursively for manifest
lists/indices). Because digests are preserved, the seeded `image.content_hash` from balenaCloud stays valid, and
`location@digest` emitted by state v3 resolves in the instance registry.

- Source auth: `{BC}/auth/v1/token?service=registry2.balena-cloud.com&scope=repository:<repo>:pull` with
  `Authorization: Bearer $BALENACLOUD_TOKEN`.
- Target auth: `{API}/auth/v1/token?service=<registryHost>&scope=repository:<repo>:pull,push` with the caller's JWT.
- Target host: `OPEN_BALENA_REGISTRY_URL`, default derived from the API URL host by replacing the leftmost label with
  `registry2` (e.g. `api.balena.example.com` → `registry2.balena.example.com`).
- Idempotent: HEAD manifest by digest in the target; skip blobs that already exist.
- Per (arch, version) in-process lock; concurrent seeds await the first.

### D3: Instance data shape mirrors balenaCloud exactly

Seeded rows replicate the balenaCloud shape the device-side supervisor expects from state v3: app `<arch>-supervisor`
(slug `balena_os/<arch>-supervisor`, public, non-host), services with the same `service_name`s, images with
instance-registry locations, release with `raw_version` = semver, semver fields, `status: 'success'`, `is_final: true`,
and the balenaCloud `composition` copied verbatim.

### D4: Version listing semantics

`GET /supervisor-releases/versions?deviceType=<slug>` resolves the device type → CPU arch → balenaCloud
`<arch>-supervisor` app, dedupes releases by `semver` (newest raw per semver), orders semver-desc, and annotates each
entry with `seeded` (instance release id present). Versions older than the device's (or a provided) current supervisor
are still listed — the UI disables them ("downgrade not allowed"); the API would reject them anyway.

### D5: Update actions — device and fleet bulk

- `POST /supervisor-releases/update` `{ version, deviceType, deviceIds: number[] }` — ensures seeded (seeds if missing),
  then PATCHes each device with the caller's JWT. Per-device results (`updated` / `rejected: <api message>`); bulk
  tolerates partial failure. Frontend offers this from the device page (single device, preselected) and as a bulk action
  on the device list / fleet page (devices grouped by device type client-side, one call per type).

## Risks / Trade-offs

- **Device-side self-update semantics**: state v3 includes the supervisor release; the device supervisor's own update
  trigger follows balenaCloud semantics because the shape is replicated faithfully. Real-device acceptance testing is
  required (documented; user validates on a live device before rolling out fleet-wide).
- **Mirror size**: ~100–250 MB per (arch, version); registry storage grows per seeded version. Acceptable: seeding is
  explicit and per-version.
- **`BALENACLOUD_TOKEN` required for seeding**: without it, listing works, seeding/mirroring returns a clear error, and
  the UI shows an explanatory notice.
- **balenaCloud dependency**: catalog and bytes come from balenaCloud; an outage only blocks new seeds, not updates to
  already-seeded versions.
- **In-process locks**: single-instance UI server assumption (consistent with the OS image cache design).

## Migration Plan

Purely additive: new routes/controller, new deps (`balena-semver` for ordering — pure JS), new env vars
(`BALENACLOUD_TOKEN`, `OPEN_BALENA_REGISTRY_URL`; `BALENACLOUD_API_URL` shared). No changes to existing resources.

## Open Questions

- None blocking.
