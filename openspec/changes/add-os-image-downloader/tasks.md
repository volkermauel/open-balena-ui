# Tasks

## 1. Server — balenaCloud version listing

- [ ] 1.1 Create `server/controller/osImage/versions.ts`: query `{BALENACLOUD_API_URL}/v7/release` (public, no auth) with the documented `$filter`/`$orderby`, extract deduplicated `raw_version` values in semver-desc order; map upstream/network failures to typed errors
- [ ] 1.2 Env plumbing: read `BALENACLOUD_API_URL` (default `https://api.balena-cloud.com`) without importing client env code

## 2. Server — cache store + LRU

- [ ] 2.1 Create `server/controller/osImage/cacheStore.ts`: path layout `img/`, `out/`, `tmp/`; key builders for pristine (`{deviceType}__{version}__{prod|dev}.img`) and artifacts (`{deviceType}__{version}__{prod|dev}__{sha16(config)}.{zip|gz}`); config canonicalization + SHA-256 (16 hex chars)
- [ ] 2.2 LRU index (in-memory, rebuilt lazily from disk on first access) over both tiers; enforce `OS_IMAGE_CACHE_MAX_GB` (default 20) after each write; never evict files locked by running jobs; evict least-recently-used first
- [ ] 2.3 Per-key download locks so balenaCloud is fetched exactly once per pristine key even under concurrent prepares
- [ ] 2.4 `cache-status` snapshot: cached versions per (deviceType, variant) with pristine/artifact flags and sizes

## 3. Server — prepare pipeline

- [ ] 3.1 `server/controller/osImage/config.ts`: forward caller's Bearer JWT to `POST {REACT_APP_OPEN_BALENA_API_URL}/download-config` with `{ appId, version, network, appUpdatePollInterval, developmentMode, wifiSsid, wifiKey }`; typed errors for 401/400
- [ ] 3.2 `server/controller/osImage/prepareJob.ts`: job registry (`crypto.randomUUID()` ids) + phase machine `downloading → injecting → compressing → ready|error`; byte progress during download when Content-Length is known; temp-file cleanup on failure
- [ ] 3.3 Download step: stream `GET {BALENACLOUD_API_URL}/download?deviceType=…&version=…&fileType=.img[&developmentMode=true]` to `img/` via lock map; reuse existing pristine file
- [ ] 3.4 Inject step: copy pristine → `tmp/`, write `config.json` into the boot partition with `balena-config-json` (validate the boot partition contains `config.json`/`device-type.json` as it does)
- [ ] 3.5 Compress step: `.gz` via `node:zlib` createGzip stream; `.zip` via `archiver`; stream into `out/` artifact path; register with LRU
- [ ] 3.6 Stream-out step: artifact → HTTP response with `Content-Disposition: attachment; filename="<deviceType>-<version>[-dev]-<fleetSlug>.<ext>"`

## 4. Server — routes + wiring

- [ ] 4.1 Create `server/routes/osImage.ts` following `registryImage.ts` conventions (typed request/response interfaces, `dosProtect` + `authorize` on every route): `GET /os-images/versions`, `GET /os-images/cache-status`, `POST /os-images/prepare`, `GET /os-images/jobs/:id`, `GET /os-images/jobs/:id/download`
- [ ] 4.2 Mount in `server/index.ts` before the static client catch-all
- [ ] 4.3 Add `os-image-cache/` to `.gitignore`

## 5. Frontend — API client + wizard

- [ ] 5.1 `src/lib/osImage.ts`: typed client for the five server routes (fetch with JWT from the existing authProvider token source used by the dataProvider)
- [ ] 5.2 `src/ui/OsDownloadDialog.tsx`: MUI/react-admin wizard dialog — device type select (from `device type` resource; preselected when opened from a fleet), version select fed by `/os-images/versions` with "cached" chips from `cache-status`, variant toggle (production/development), format select (`.zip`/`.gz`), fleet select (preselected), config options (network ethernet/wifi + SSID/key when wifi, app update poll interval), download button that starts prepare, polls the job, shows phase/progress, then triggers the browser download
- [ ] 5.3 Error surfacing: unauthorized config generation, missing dev image for a device type/version, upstream balenaCloud failures — as MUI Alerts in the dialog

## 6. Frontend — fleet integration

- [ ] 6.1 "Download OS" action on fleet list rows and the fleet detail/show view; opens the dialog with fleet + device type preselected

## 7. Tests

- [ ] 7.1 `tests/osImage/*.test.ts` with `node:test` (run via `tsx`): version-list normalization/dedup/order, cache key builders, config canonicalization/hash stability, LRU eviction order + cap enforcement + running-job protection, cache-status snapshot; use temp dirs, no network
- [ ] 7.2 Add `"test": "tsx --test tests/**/*.test.ts"` npm script; wire into `.github/workflows/ci.yml` after typecheck

## 8. Build / CI verification

- [ ] 8.1 `npm install` new deps (`balena-image-fs`, `balena-config-json`, `file-disk`, `partitioninfo`, `archiver`, `@types/archiver`); `npm run typecheck` and `npm run prettier` clean
- [ ] 8.2 `npm run build:server` — verify ncc emits native `.node` assets into `dist/server`; start `node dist/server/index.js` and confirm routes respond (401 without token). If native assets break the bundle, switch those packages to ncc `--external` and adjust `Dockerfile`/`docker.yml` runtime stage to retain their `node_modules`
- [ ] 8.3 `npm run build` (client+server) green end-to-end; `npm test` green

## 9. Docs

- [ ] 9.1 README: document `OS_IMAGE_CACHE_DIR`, `OS_IMAGE_CACHE_MAX_GB`, `BALENACLOUD_API_URL`; describe the feature and the cache behavior (balenaCloud touched once per image; artifacts reused per config; LRU cap)
