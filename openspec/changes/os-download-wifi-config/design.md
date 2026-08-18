## Context

`POST /download-config` (open-balena-api `device-config/download.ts`) accepts `network`, `wifiSsid`, `wifiKey`,
`deviceType` and friends and folds them into config.json via `generateConfig`; `network` and the wifi credentials are
independent options, so credentials may be embedded for any network value. The handler falls back to the application's
device type when `deviceType` is absent. Each call mints a provisioning API key for the calling user.

## Goals / Non-Goals

- Goal: optional wifi for every network choice; instant config-only download; mixed-fleet-correct device type in
  generated configs (both flows).
- Non-goal: caching configs (per-user provisioning key), exposing device-type-specific os-config options beyond what
  /download-config itself accepts.

## Decisions

- Reuse `generateFleetConfig` + `applyGatewaySshKeys` for the config-only route: one generator, identical semantics to
  the injected config, gateway SSH keys included either way.
- POST (not GET) with the session JWT: the body carries the same options shape as prepare and the browser fetch cannot
  attach Authorization on a plain navigation — same object-URL hand-off as the artifact download.
- New parser `parseOsConfigRequest` instead of reusing the prepare parser: variant/format are artifact-only fields and a
  406 naming them would be confusing for a config download.
- `deviceType` becomes an explicit `FleetConfigOptions` field forwarded to `/download-config`.

## Risks / Trade-offs

- The minted provisioning key is long-lived per download; repeated config-only downloads mint one key each (openBalena
  behavior, same as the balena-cli config download).

## Migration Plan

Additive route + UI; no config or schema changes.
