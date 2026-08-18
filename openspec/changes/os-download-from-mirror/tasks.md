- [x] 1. `versions.ts`: mirror-release catalog — paginate GitHub `/releases` (anonymous, 5-min in-process cache), match
     `balenaos-<v>-<dt>.img.zip` assets, balena-semver desc order; `OS_IMAGE_SOURCE_REPO` env (default
     `volkermauel/balena-raspberrypi-abrp`), validated `<owner>/<repo>`; `BALENACLOUD_API_URL` references removed from
     this flow
     - The asset pattern embeds the (validated) device type slug exactly as design.md's
       `^balenaos-(?<v>.+)-<dt>\.img\.zip$`; a generic `machine` capture group cannot be used because regex backtracking
       mis-splits hyphenated slugs (`raspberrypi4-64` parses as machine `64`)
- [x] 2. `prepareJob.ts`: download the asset `browser_download_url` → stream to pristine cache as `.zip` → sha256-verify
     against the release's `SHA256SUMS` entry (missing entry = fail-closed error naming it) → unzip before injection;
     recompress per requested format; reject `variant !== 'production'` in the route (406)
     - Pristine cache key extension changed `.img` → `.zip` (`pristineFilename`); the filename parser still accepts the
       legacy `.img` layout for files aging out on disk
     - No new dependency: no unzip library exists in the dependency tree (checked package-lock), so unpacking is
       implemented in `server/controller/osImage/zip.ts` — central-directory parsing (incl. zip64) + `zlib.inflateRaw`
       streaming with per-entry CRC-32/size verification
     - The missing-checksum check runs before any bytes are fetched, so no partial file can exist on that path; a hash
       mismatch deletes the partial file and never registers the cache entry
- [x] 3. `routes/osImage.ts`: `appUpdatePollInterval` defaults to `10` when omitted
     - Validation moved into the pure parser `server/controller/osImage/request.ts` (imported by the route) so the 406
       variant rejection and poll-interval default are unit-testable without an HTTP harness
- [x] 4. `config.ts`: `GATEWAY_SSH_PUBLIC_KEYS` parsing (newline-split, trim, drop empties, each key must start
     `ssh-`-prefixed pattern `^ssh-(rsa|dss|ed25519|ecdsa)-`); merge into `config.os.sshKeys` after `/download-config`,
     before `configJson.write`
     - Deviation: the sketched pattern `^ssh-(rsa|dss|ed25519|ecdsa)-…` cannot match any real public key
       (`ssh-rsa`/`ssh-ed25519` carry no second hyphen; ecdsa keys are `ecdsa-sha2-nistp256`-prefixed). The accepted
       pattern is the families' real openssh formats: `ssh-(rsa|dss|ed25519)` and `ecdsa-sha2-nistp(256|384|521)` +
       base64 + optional comment
- [x] 5. `OsDownloadDialog.tsx` / `FleetDownloadOsButton.tsx`: pass the launching fleet record; seed the dropdown with
     it; select it; device-type change filters fleets client-side via `is for-device type`; drop the `is of-class`
     filter; remove the variant radio (production hardwired)
- [x] 6. Tests: mirror catalog (asset matching, ordering, empty device type, upstream failure, 5-min cache), sha256
     verify (match, mismatch, missing entry), poll-interval default, gateway keys (set/empty/invalid), route 406 on
     development variant, fleet-dropdown seeding (component-level where the existing tests do that)
     - The repo has no component test harness, so the fleet-dropdown seeding/filtering logic lives in pure helpers
       (`mergeFleetRecords`, `fleetMatchesDeviceType` in `src/lib/osImage.ts`) and is unit-tested in
       `tests/osImage/fleets.test.ts`; the route assertions run against `parsePrepareOsImageRequest`
     - Added `tests/osImage/zip.test.ts` for the unpacker (deflate/stored extraction, CRC corruption, non-zip rejection)
- [x] 7. README: `OS_IMAGE_SOURCE_REPO`, `GATEWAY_SSH_PUBLIC_KEYS`, poll-interval default, mirror-sourced versions;
     remove balenaCloud catalog references for this feature
- [x] 8. `npm test`, `npx tsc --noEmit`, `npm run build`, `npx prettier --check .` green;
     `openspec validate os-download-from-mirror --strict` and `openspec validate fix-image-push-timestamp --strict` pass

## Review fixes

Independent review (0 blockers, 0 majors) — all findings addressed:

- [x] `zip.ts`: oversize-inflation guard — the verify transform fails as soon as `writtenBytes` exceeds the entry's
      declared uncompressed size (tested: declared 1 B inflating to 64 KiB → typed corrupt-archive error, destination
      left without the full payload)
- [x] `tests/osImage/zip.test.ts`: hand-built zip64 fixture (CD 0xFFFF/0xFFFFFFFF placeholders + zip64 extra field,
      zip64 EOCD locator + EOCD; local sizes real) exercising `parseZip64Tail`/`readZipEntries`; shared fixture builders
      moved to `tests/osImage/helpers.ts`
- [x] `versions.ts`: single-flight catalog cache — the in-flight promise is stored in `mirrorCatalogCache`, cold misses
      share one pagination run, TTL stays 5 min, a rejected run evicts itself (tested)
- [x] fetch timeouts: asset download 10 min (`MIRROR_ASSET_DOWNLOAD_TIMEOUT_MS`), GitHub API catalog and SHA256SUMS
      fetches 30 s (`MIRROR_FETCH_TIMEOUT_MS`); timeout rejections surface as the existing typed 502s
- [x] `design.md` Migration Plan rewritten honestly: legacy `.img` pristine entries are not reused (key is now `.zip`),
      they remain for status/LRU only, the cached badge may precede a re-download; removed the false "fallback string
      compare" claim (balena-semver rcompare degrades gracefully)
- [x] `nextReleasesUrlFromLink`: per-entry parsing accepting `rel=next`, `rel="next"; title="page 2"` forms (tested,
      including near-miss rejections)
- [x] `OsDownloadDialog.tsx`: fleet/device-type load failures land in a dedicated `choicesError` state rendered at the
      fleet dropdown
- [x] `fleets.test.ts`: mixed-id-type merge case (seeded `42` + server `'42'` → one entry, server record wins)
- [x] `config.ts`: gateway SSH key pattern generalized to `sk-` hardware and `-cert-v01@openssh.com` certificate forms
      (existing keys re-validated, new fixtures, error still names the env var)
- [x] `tests/osImage/prepareJob.test.ts`: runOsImageJob-level integration tests (mocked fetch + real zip fixture +
      patched `balena-config-json.write`): ordering listing → sums → asset → fleet config, gateway keys present in the
      injected config, artifact committed, working image cleaned up — plus the unzip-failure cleanup path
- [x] pagination tests: two-page merge duplicate-free (release- and version-level), no-Link response terminates after
      one fetch
