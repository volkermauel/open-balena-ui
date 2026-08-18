## Summary

Supervisor images are sourced from a self-built ghcr mirror (`ghcr.io/volkermauel/aarch64-supervisor:<tag>`,
anonymous pull) instead of balenaCloud's `registry2`. `BALENACLOUD_TOKEN` is no longer needed anywhere.

## Why

- The instance operator already builds the supervisor from `balena-io/balena-supervisor` source in
  `volkermauel/balena-raspberrypi-abrp` (workflow `build-supervisor.yml`) and publishes it to ghcr with
  anonymous pulls — a fully self-hosted, token-free supply chain.
- `registry2.balena-cloud.com` pulls require a balenaCloud JWT (`BALENACLOUD_TOKEN`), the last remaining
  dependency on a balenaCloud account.

## What Changes

- New env `SUPERVISOR_SOURCE_REGISTRY` (`<registry-host>[/owner]`, default `ghcr.io/volkermauel`). Source
  repository per arch: `<owner>/<arch>-supervisor` (no owner prefix → `<arch>-supervisor`). Anonymous pull
  tokens, exactly like the hostOS mirror.
- Version catalog = tags on the mirror repository (parsed as semver, `v` prefix tolerated), enriched with
  balenaCloud public-catalog metadata (variant, service names, cloud release id) on a best-effort basis.
  A mirror tag unknown to balenaCloud is still listed; its service name defaults to `supervisor`.
- Seeding resolves the tag's manifest digest on the mirror (GET manifest by tag, `Docker-Content-Digest`
  header), uses **that digest** as the image row's content hash (the self-built image ≠ balenaCloud's build),
  and mirrors bytes from the mirror into the instance registry — digest-preserving as before.
- `BALENACLOUD_TOKEN`, the `balena-cloud` source-auth mode, `MirroringNotConfiguredError`, and the related
  UI notice are removed. `BALENACLOUD_API_URL` remains (anonymous metadata enrichment only).
- A missing tag on the mirror is a clear `404`-style error ("version not on the mirror — build it via the
  mirror repo's supervisor workflow").

## Impact

- Server: `supervisorRelease/registryMirror.ts`, `cloud.ts`, `seed.ts`, `errors.ts`, `routes/supervisorRelease.ts`
- UI: `SupervisorUpdateDialog.tsx` (token notice removed)
- Docs: README supervisor env section; tests for catalog/seed/mirror
