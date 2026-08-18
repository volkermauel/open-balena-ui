# add-hostos-version-management — tasks

## Server implementation

- [ ] Generalize `registryMirror.ts`: source host + auth mode params (anonymous token / balenaCloud bearer); supervisor
      call sites unchanged (typecheck + existing 28 tests stay green)
- [ ] `hostosCatalog.ts`: ghcr anonymous token, `tags/list` fetch, tag→semver/raw parsing (pure, unit tested),
      machine-from-slug
- [ ] `hostosSeed.ts`: idempotent import (image row → mirror+verify → release on hostapp app → release_image),
      per-deviceType lock, planner-driven (unit-tested pure plan, like supervisor seeding)
- [ ] Routes `/hostos-releases/{versions,seed}` behind `dosProtect` + `authorize`, `{success,message}` error shape
- [ ] Mount in `server/index.ts`

## Frontend

- [ ] `src/lib/hostosRelease.ts` client
- [ ] Import-management UI: device-type versions list with imported state + Import action (reuse dialog patterns)
- [ ] Surface in a sensible existing location (device type admin / settings), MUI + react-admin idioms

## Tests

- [ ] `tests/hostosRelease/`: catalog parsing (tag↔semver), seed planner, mirror-from-ghcr flow with fetch mocked
      (anonymous token path), idempotency short-circuit

## Gates & docs

- [ ] typecheck, tests, prettier, build, boot check (routes 401 unauth)
- [ ] README: `HOSTOS_SOURCE_REGISTRY`, `HOSTOS_SOURCE_REPO`
- [ ] Commit referencing volkermauel/open-balena-ui#3; push branch to fork (no PR)
