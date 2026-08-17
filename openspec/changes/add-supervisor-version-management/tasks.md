# Tasks

## 1. Server — balenaCloud catalog client

- [ ] 1.1 `server/controller/supervisorRelease/cloud.ts`: anonymous reads — app by slug `balena_os/<arch>-supervisor`, releases (status success, `$orderby=id desc`), `release_image`, `image` (location + content_hash + `is_a_build_of__service` expand), service names; typed errors; env `BALENACLOUD_API_URL` default `https://api.balena-cloud.com`
- [ ] 1.2 Version normalization: dedupe by `semver` (keep newest raw per semver), order semver-desc with `balena-semver`

## 2. Server — instance seeding (idempotent)

- [ ] 2.1 `server/controller/supervisorRelease/instance.ts`: read instance state with the forwarded JWT — existing supervisor apps by slug, releases by (app, semver), services by name, images by content_hash
- [ ] 2.2 `server/controller/supervisorRelease/seed.ts`: create-if-missing in crash-safe order: app (`<arch>-supervisor`, public, non-host, `is_for__device_type` = an instance device type of that arch) → services → images (instance-registry location, balenaCloud content_hash) → **mirror blobs** → release (`raw_version`=semver, semver fields, `status: 'success'`, `is_final: true`, composition copied) → `release_image` links; per-(arch, version) in-process lock; device-type→arch resolution via instance `device_type` expand `is_of__cpu_architecture`
- [ ] 2.3 Use the same endpoint path style and resource names the UI's dataProvider uses (read `src/dataProvider/index.ts`); all writes with the caller's forwarded `Authorization` header

## 3. Server — registry mirroring

- [ ] 3.1 `server/controller/supervisorRelease/registryMirror.ts`: source token (`{BC}/auth/v1/token` with `BALENACLOUD_TOKEN`), target token (instance `/auth/v1/token` with caller JWT, scope `repository:<repo>:pull,push`); registry host from `OPEN_BALENA_REGISTRY_URL` or derived (`api.` → `registry2.`)
- [ ] 3.2 Copy: manifest by digest byte-identical (Accept: docker v2/v2-list + OCI manifest/index), recurse referenced manifests/config/layers; HEAD-check target blob existence, stream through (no full-image buffering); idempotent by digest
- [ ] 3.3 Clear typed error when `BALENACLOUD_TOKEN` is unset ("mirroring not configured") — listing must keep working without it

## 4. Server — routes

- [ ] 4.1 `server/routes/supervisorRelease.ts` (conventions of `registryImage.ts`; `dosProtect` + `authorize`): `GET /supervisor-releases/versions?deviceType=`, `GET /supervisor-releases/status?deviceId=`, `POST /supervisor-releases/seed {deviceType, version}`, `POST /supervisor-releases/update {deviceType, version, deviceIds[]}` (ensures seeded; per-device PATCH results; bulk tolerates partial failure)
- [ ] 4.2 Mount in `server/index.ts` before the static catch-all

## 5. Frontend — API client + dialog

- [ ] 5.1 `src/lib/supervisorRelease.ts`: typed client for the four routes (JWT from the same source the dataProvider uses)
- [ ] 5.2 `src/ui/SupervisorUpdateDialog.tsx`: version list (current version marked; older versions disabled with "downgrade not allowed" hint), seed phases feedback (metadata → mirroring → applying), per-device results for bulk, "mirroring not configured" Alert, error surfacing
- [ ] 5.3 Device dashboard supervisor card: show current supervisor version + target (if `should be managed by-release` set — respect `src/versions/index.ts` field mappings) and an "Update Supervisor" button opening the dialog

## 6. Frontend — bulk actions

- [ ] 6.1 Device list bulk action "Update Supervisor" (validate same device type across selection)
- [ ] 6.2 Fleet page action: update supervisor for all devices of the fleet (grouped by device type client-side)

## 7. Tests

- [ ] 7.1 `tests/supervisorRelease/*.test.ts` (`node:test`, mocked fetch, no network): version dedup/order, device-type→arch→app-slug mapping, registry host derivation, mirror plan (manifest → blob set, list recursion) against fixture manifests, seed idempotency decision logic, downgrade pre-filter for UI list, bulk result aggregation
- [ ] 7.2 `npm test` script + CI wiring (if not already present from the OS-image change)

## 8. Docs & verification

- [ ] 8.1 README: feature section + env vars `BALENACLOUD_TOKEN`, `OPEN_BALENA_REGISTRY_URL` (+ `BALENACLOUD_API_URL` if new)
- [ ] 8.2 Gates: `npm run typecheck`, `npm test`, `npm run prettier`, `npm run build` all clean; boot the built server and verify routes respond 401 unauthenticated
- [ ] 8.3 Live read-only smoke: anonymous balenaCloud catalog queries for a real arch return versions; instance `device_type` arch resolution works with a forwarded token (no writes)
