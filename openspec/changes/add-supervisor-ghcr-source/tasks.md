- [x] 1. `registryMirror.ts`: remove `balena-cloud` auth mode, `BALENACLOUD_TOKEN` reads, `MirroringNotConfiguredError`;
     add `SUPERVISOR_SOURCE_REGISTRY` env parsing (`<host>[/owner]`, default `ghcr.io/volkermauel`) and
     `supervisorSourceRepo(arch)`
- [x] 2. `registryMirror.ts`: add `resolveTagDigest(caller, repo, tag, source)` — GET manifest by tag,
     `Docker-Content-Digest` header with sha256-body fallback, `assertDigest`-validated
  - Signature is `resolveTagDigest(repo, tag, source)` — no caller authorization needed (source pulls are anonymous).
- [x] 3. `cloud.ts`: mirror-tag catalog (`tags/list?n=1000`, semver-parse `^v?\d+…`, balena-semver order) with
     best-effort balenaCloud enrichment (variant, service names, cloud release id)
  - Listing enrichment attaches variant + cloud release id; the per-version service name is resolved lazily at seed time
    (`serviceNameForVersion`) to avoid one images request per listed version.
- [x] 4. `seed.ts`: build the single image descriptor from (mirror repo, resolved digest, service name); content hash =
     mirror digest; keep read-back (`getImageLocation`) mirroring behavior
- [x] 5. `errors.ts`: drop token error class; add tag-not-on-mirror error (404-style, actionable message)
  - `SupervisorTagMissingError extends NotFoundError`, so the existing route mapping renders it as a 404 unchanged.
- [x] 6. `routes/supervisorRelease.ts` + `SupervisorUpdateDialog.tsx`: listing consumes the mirror catalog; remove the
     `BALENACLOUD_TOKEN` notice
  - Response shape unchanged; `mirroringEnabled` is now a constant `true` (anonymous mirroring is always available) and
    the dialog drops its mirroring gate.
- [x] 7. Tests: mirror token/tags/manifest mocks; digest-by-tag resolution (header + body-hash fallback); tag-missing
     error; empty-arch listing; enrichment-unavailable listing; re-seed no-op still green
- [x] 8. README: rewrite supervisor env section (`SUPERVISOR_SOURCE_REGISTRY` default, token removed,
     `BALENACLOUD_API_URL` = optional enrichment)
- [x] 9. `npm test`, `npx tsc --noEmit`, `npm run build`, `npx prettier --check .` all green
  - `MirroringNotConfiguredError` was also re-exported by the hostOS feature (errors.ts, route guard, one test env
    cleanup line); those references were removed as dead code — nothing can throw it anymore.
  - `prettier --check .` also required formatting pre-existing unformatted openspec markdown
    (add-hostos-version-management and this change's docs); content untouched, wrapping only.
