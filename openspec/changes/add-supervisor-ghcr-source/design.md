# Supervisor ghcr-source redesign

## Context

The supervisor feature currently treats balenaCloud as the image source of truth: the catalog lists balenaCloud
supervisor releases, seeding copies the release's image (repository path **and digest** come from balenaCloud's
`is_stored_at__image_location` + `content_hash`), and pulls from `registry2.balena-cloud.com` with a
`BALENACLOUD_TOKEN`-backed pull token.

The operator's ghcr mirror (`volkermauel/balena-raspberrypi-abrp`, workflow `build-supervisor.yml`) builds the same
supervisor from source and publishes `ghcr.io/volkermauel/aarch64-supervisor:<balena-supervisor release tag>` with
anonymous pulls. The fork should depend on that mirror only — no balenaCloud account.

## Goals / Non-Goals

- Goals: token-free supervisor sourcing; catalog reflects what the mirror actually serves; digest correctness (device
  pulls must match the mirrored bytes); minimal UI change.
- Non-Goals: multi-arch mirrors (aarch64 only today — other arches simply have no versions listed); changing device
  targeting mechanics; keeping any `registry2` fallback.

## Decisions

- **Catalog source = mirror tags.** `GET <source>/v2/<owner>/<arch>-supervisor/tags/list?n=1000`, parse
  `^v?\d+\.\d+\.\d+([-.+].*)?$` as semver (reuse `balena-semver` ordering). The balenaCloud public catalog is
  best-effort enrichment (variant, service names, cloud release id) — enrichment failure never fails listing;
  unknown-to-cloud tags list with `serviceName: 'supervisor'`, `variant: ''`.
- **Digest identity = mirror manifest digest.** Resolve `Docker-Content-Digest` from a GET-by-tag manifest request
  (Accept: manifest+index types, same header constant as the mirror code). This digest becomes the image row
  `content_hash` and the value verified after mirroring. balenaCloud digests are never used.
- **Env parsing shared shape.** `SUPERVISOR_SOURCE_REGISTRY` accepts `<registry-host>[/owner]` (default
  `ghcr.io/volkermauel`), mirroring `HOSTOS_SOURCE_REGISTRY`'s contract; url = `https://<host>`.
- **Auth simplification.** `SourceAuthMode` reduces to anonymous-only; the `balena-cloud` branch, `BALENACLOUD_TOKEN`
  reads, and `MirroringNotConfiguredError` are deleted rather than stubbed.
- **Single-image assumption made explicit.** Supervisor releases carry exactly one image; seeding builds the image
  descriptor from (mirror repo, resolved digest, service name) instead of cloud release images.

## Risks / Trade-offs

- Mirror serves one arch and one tag today; catalog for other arches is legitimately empty (UI shows "no versions").
  Acceptable: this fork targets the operator's aarch64 fleet.
- GET-by-tag digest: ghcr returns `Docker-Content-Digest` on GET; if a registry omitted it, the response body is
  sha256-hashed locally as a fallback (verified digest either way via `assertDigest`).

## Migration Plan

None needed — no persisted state changes. Deployments that set `BALENACLOUD_TOKEN` simply stop needing it; image rows
seeded previously (balenaCloud digests) remain valid immutable content.

## Open Questions

- None.
