- [ ] 1. `registryMirror.ts`: remove `balena-cloud` auth mode, `BALENACLOUD_TOKEN` reads,
       `MirroringNotConfiguredError`; add `SUPERVISOR_SOURCE_REGISTRY` env parsing
       (`<host>[/owner]`, default `ghcr.io/volkermauel`) and `supervisorSourceRepo(arch)`
- [ ] 2. `registryMirror.ts`: add `resolveTagDigest(caller, repo, tag, source)` — GET manifest by tag,
       `Docker-Content-Digest` header with sha256-body fallback, `assertDigest`-validated
- [ ] 3. `cloud.ts`: mirror-tag catalog (`tags/list?n=1000`, semver-parse `^v?\d+…`, balena-semver order)
       with best-effort balenaCloud enrichment (variant, service names, cloud release id)
- [ ] 4. `seed.ts`: build the single image descriptor from (mirror repo, resolved digest, service name);
       content hash = mirror digest; keep read-back (`getImageLocation`) mirroring behavior
- [ ] 5. `errors.ts`: drop token error class; add tag-not-on-mirror error (404-style, actionable message)
- [ ] 6. `routes/supervisorRelease.ts` + `SupervisorUpdateDialog.tsx`: listing consumes the mirror
       catalog; remove the `BALENACLOUD_TOKEN` notice
- [ ] 7. Tests: mirror token/tags/manifest mocks; digest-by-tag resolution (header + body-hash fallback);
       tag-missing error; empty-arch listing; enrichment-unavailable listing; re-seed no-op still green
- [ ] 8. README: rewrite supervisor env section (`SUPERVISOR_SOURCE_REGISTRY` default, token removed,
       `BALENACLOUD_API_URL` = optional enrichment)
- [ ] 9. `npm test`, `npx tsc --noEmit`, `npm run build`, `npx prettier --check .` all green
