## Summary

The OS-download dialog gains two capabilities: (1) wifi credentials become an explicit optional section available for
every network choice — checking "Add wifi credentials" embeds the SSID/key even when the primary network is ethernet
(balenaOS then uses wifi as a fallback); (2) a "Config only" action downloads just the provisioned `config.json` — the
same config the image injection would embed — without downloading or unpacking any image.

## Why

Wifi-attached devices currently force the operator to switch the network radio to `wifi` merely to type credentials. And
flashing tools (balenaEtcher) accept a separately-supplied config.json, so a full multi-GB image download is often
unnecessary when the operator only needs the config.

## What Changes

- Dialog: "Add wifi credentials" checkbox (implied and locked when network=wifi); SSID/key fields follow for any network
  choice. New "Config only" button + success/error alerts.
- New route `POST /os-images/config`: parses an `OsConfigRequest` (prepare minus variant/format), calls openBalena
  `/download-config` with the caller's JWT (same generator and GATEWAY_SSH_PUBLIC_KEYS merge as the injection flow),
  streams the JSON back as an attachment named `<deviceType>-<version>-<fleet>-config.json`. The config embeds a freshly
  minted provisioning API key — per-user, never cached.
- `FleetConfigOptions`/`buildDownloadConfigBody` now pass `deviceType` through so mixed fleets generate the config for
  the _selected_ device type instead of openBalena's fleet-type fallback (also corrects the injection flow for mixed
  fleets).

## Impact

- `server/routes/osImage.ts`, `server/controller/osImage/{request,config,prepareJob,cacheStore}.ts`,
  `src/lib/osImage.ts`, `src/ui/OsDownloadDialog.tsx`, tests.
