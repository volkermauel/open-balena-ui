# add-hostos-version-management — design

## Context

Verified live against `ghcr.io/volkermauel/balenaos-hostapp` (anonymous):
- token: `GET https://ghcr.io/token?scope=repository:<owner>/balenaos-hostapp/<machine>:pull` (no Authorization header)
- tags: `GET /v2/<owner>/balenaos-hostapp/<machine>/tags/list?n=1000` → 200 anonymous
- manifest HEAD by tag → 200, `application/vnd.docker.distribution.manifest.v2+json`, `docker-content-digest`
- tag convention: release `v7.4.0+rev5` ↔ ghcr `7.4.0-rev5` (`+`→`-`); machines = device-type slugs

Instance side (verified in earlier change): `formatImageLocation` = `toLowerCase()` pass-through — seeded
instance-registry locations reach devices verbatim; hostapp apps exist per device type (`admin/raspberrypi4-64`,
`admin/raspberrypi5`); releases of `is host` apps are what the Target-OS selector serves via
`should be operated by-release`.

## Decisions

- **D1 — Source = ghcr mirror (anonymous).** No `BALENACLOUD_TOKEN` on this path; catalog = `tags/list`, images =
  digest pulls. `HOSTOS_SOURCE_REGISTRY` / `HOSTOS_SOURCE_REPO` env-overridable.
- **D2 — Reuse the supervisor track's mirror, generalized.** `registryMirror` gains source-host + source-auth-mode
  parameters (ghcr: anonymous token; balenaCloud: bearer `BALENACLOUD_TOKEN` — supervisor behavior byte-identical).
  Same digest validation, children-first recursion, HEAD-skip, POST→Location→PUT streaming, digest verification.
- **D3 — Seeding mirrors the supervisor shape** (idempotent lookups-before-creates, crash-safe order: image metadata →
  mirror+verify → release → release_image; per-(deviceType, version) lock keyed on deviceType) with two differences:
  - no app/service creation — the hostapp app (`admin/<slug>`) already exists; releases attach to it
  - the image repo path is the mirror's machine path (`balenaos-hostapp/<machine>`), the location written to the
    image row is `<instance-registry-host>/v2/balenaos-hostapp/<machine>`
- **D4 — No targeting endpoints.** The built-in Target-OS selector lists hostapp releases and PATCHes
  `should be operated by-release`; imported versions appear there automatically.
- **D5 — Version parsing.** ghcr tag → semver by reversing the `+`→`-` swap (`7.4.0-rev5` → `7.4.0+rev5`,
  `v19.0.8` → `19.0.8`); `raw_version` keeps the mirrored tag verbatim. `commit` = sha256(`<machine>:<tag>`)[:40].

## Risks / Trade-offs

- Machine↔slug is assumed 1:1 (true today: raspberrypi4-64, raspberrypi5). A future non-slug machine would need a
  mapping table — env override mitigates.
- Real-device acceptance (a device actually applying an imported hostapp update) remains with the operator.
- ghcr tag ordering: `tags/list` is lexicographic; we order by parsed semver (balena-semver rcompare), falling back
  to raw string order for unparsable tags.
