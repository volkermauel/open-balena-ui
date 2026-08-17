# OpenSpec Project Context

## Why

This project provides `open-balena-ui`: a web UI (react-admin) with a small companion Express server for administering
an openBalena instance — fleets, devices, releases, users, and registry maintenance.

## What Changes

Changes are managed as OpenSpec change proposals under `openspec/changes/`.

## Capability

`open-balena-ui` is a single product: a TypeScript Express server (`server/`) that serves the built client
(`dist/client`) and exposes authenticated JSON routes, plus a react-admin SPA (`src/`) that talks to openBalena's OData
API and the UI server routes.

## Quality

- Code is formatted with Prettier (`npm run prettier`) and type-checked with `npm run typecheck`.
- Tests use Node's built-in `node:test` runner via `tsx` (no additional test dependencies).
- New server routes follow the existing pattern: `server/routes/<name>.ts` + `server/controller/<name>/`, guarded by
  `authorize` (JWT, `OPEN_BALENA_JWT_SECRET`) and `dosProtect`.
- The server bundle is produced with `ncc` (`npm run build:server`); changes must keep that build working, including
  native module assets.

## Risks

- The upstream openBalena API evolves; field/name drift is handled via `src/versions/index.ts` mappings.
- balenaCloud public endpoints (version listing, image download) are external dependencies and must be proxied
  server-side, never directly from the browser.
