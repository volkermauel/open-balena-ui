## Why

Devices can only in-place-update their OS to hostapp releases that exist **on the instance** (apps + registry bytes).
Self-built balenaOS versions are published at `volkermauel/balena-raspberrypi-abrp` as ghcr hostapp images
(`ghcr.io/volkermauel/balenaos-hostapp/<machine>:<version>`, anonymous pulls verified, tag convention `+`→`-`), but
importing them today is manual registry + API work. We want a one-click "import hostOS version X" so the release appears
in the existing Target-OS selector and devices update in place. Tracked in volkermauel/open-balena-ui#3.

## What Changes

- New capability `hostos-version-management`:
  - `GET /hostos-releases/versions?deviceType=<slug>` — versions available in the ghcr mirror for the device type,
    newest-first, annotated with import state on the instance
  - `POST /hostos-releases/seed {deviceType, version}` — idempotent import: image row (instance-registry location),
    release on the device type's hostapp app (`admin/<slug>`), `release_image` link, and byte-identical
    digest-preserving image mirroring ghcr → instance registry
  - Management UI: hostOS versions per device type with imported state and an Import action
- `registryMirror` (from the supervisor change) generalized: source registry host and source auth (none for ghcr's
  anonymous pull) become parameters; balenaCloud remains the default source for supervisor mirroring, unchanged
- No device-targeting endpoints: the built-in Target-OS selector (`should be operated by-release`) already picks up
  imported releases

## Source catalog (verified)

- Tags: `GET https://ghcr.io/v2/<owner>/balenaos-hostapp/<machine>/tags/list?n=1000` with anonymous
  `?scope=repository:...:pull` token; machines map 1:1 to device-type slugs (`raspberrypi4-64`, `raspberrypi5`)
- Release tag ↔ ghcr tag: `v7.4.0+rev5` ↔ `7.4.0-rev5` (`+`→`-`)
- Manifests: docker v2 (single-arch per machine), `docker-content-digest` present

## Environment

| Variable                 | Default                                | Purpose                                                         |
| ------------------------ | -------------------------------------- | --------------------------------------------------------------- |
| `HOSTOS_SOURCE_REGISTRY` | `ghcr.io/volkermauel/balenaos-hostapp` | Mirror location (owner/repo path + host)                        |
| `HOSTOS_SOURCE_REPO`     | `volkermauel/balena-raspberrypi-abrp`  | Companion GitHub repo (catalog cross-check, release notes link) |
