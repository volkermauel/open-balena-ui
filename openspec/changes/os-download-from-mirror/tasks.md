- [ ] 1. `versions.ts`: mirror-release catalog — paginate GitHub `/releases` (anonymous, 5-min
       in-process cache), match `balenaos-<v>-<dt>.img.zip` assets, balena-semver desc order;
       `OS_IMAGE_SOURCE_REPO` env (default `volkermauel/balena-raspberrypi-abrp`), validated
       `<owner>/<repo>`; `BALENACLOUD_API_URL` references removed from this flow
- [ ] 2. `prepareJob.ts`: download the asset `browser_download_url` → stream to pristine cache as
       `.zip` → sha256-verify against the release's `SHA256SUMS` entry (missing entry = fail-closed
       error naming it) → unzip before injection; recompress per requested format; reject
       `variant !== 'production'` in the route (406)
- [ ] 3. `routes/osImage.ts`: `appUpdatePollInterval` defaults to `10` when omitted
- [ ] 4. `config.ts`: `GATEWAY_SSH_PUBLIC_KEYS` parsing (newline-split, trim, drop empties, each
       key must start `ssh-`-prefixed pattern `^ssh-(rsa|dss|ed25519|ecdsa)-`); merge into
       `config.os.sshKeys` after `/download-config`, before `configJson.write`
- [ ] 5. `OsDownloadDialog.tsx` / `FleetDownloadOsButton.tsx`: pass the launching fleet record;
       seed the dropdown with it; select it; device-type change filters fleets client-side via
       `is for-device type`; drop the `is of-class` filter; remove the variant radio (production
       hardwired)
- [ ] 6. Tests: mirror catalog (asset matching, ordering, empty device type, upstream failure,
       5-min cache), sha256 verify (match, mismatch, missing entry), poll-interval default,
       gateway keys (set/empty/invalid), route 406 on development variant, fleet-dropdown seeding
       (component-level where the existing tests do that)
- [ ] 7. README: `OS_IMAGE_SOURCE_REPO`, `GATEWAY_SSH_PUBLIC_KEYS`, poll-interval default,
       mirror-sourced versions; remove balenaCloud catalog references for this feature
- [ ] 8. `npm test`, `npx tsc --noEmit`, `npm run build`, `npx prettier --check .` green;
       `openspec validate os-download-from-mirror --strict` and
       `openspec validate fix-image-push-timestamp --strict` pass
