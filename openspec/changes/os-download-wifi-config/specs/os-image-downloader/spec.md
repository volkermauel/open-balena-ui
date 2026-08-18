# os-download-wifi-config — spec deltas

## ADDED Requirements

### Requirement: Config-only download

The ui server SHALL offer an authenticated `POST /os-images/config` endpoint that generates the fleet provisioning
config with the caller's own credentials (identical generator, options and gateway SSH-key merge as the image-injection
flow) and returns it as a JSON attachment, without downloading, unpacking or caching any image bytes. The endpoint SHALL
NOT cache responses because each generated config embeds a freshly minted per-user provisioning API key.

#### Scenario: Config only

- **WHEN** a logged-in user requests a config for device type `raspberrypi4-64`, version `7.4.0+rev5` and a fleet, with
  an ethernet network plus optional wifi credentials
- **THEN** the response is a `config.json` attachment named after the device type, version and fleet, containing the
  wifi credentials and the gateway SSH keys, and no image was downloaded

#### Scenario: Wifi required

- **WHEN** the request selects the `wifi` network without an SSID
- **THEN** the endpoint responds 406 asking for `wifiSsid`

## MODIFIED Requirements

### Requirement: Wifi credentials are optional for every network choice

The OS-download dialog SHALL offer wifi credentials behind an "Add wifi credentials" checkbox that is available for
every network choice; selecting the `wifi` network SHALL imply the checkbox. When provided, the credentials SHALL be
sent to the config generator for both the image-injection and the config-only flows regardless of the primary network.

#### Scenario: Ethernet with wifi fallback

- **WHEN** the user keeps `ethernet` selected, checks "Add wifi credentials" and enters SSID/key
- **THEN** the prepared image (and the config-only download) embeds the wifi credentials alongside the ethernet network
  setting

## MODIFIED Requirements

### Requirement: Config generation uses the selected device type

Config generation (both injection and config-only) SHALL forward the dialog's selected device type to `/download-config`
so mixed-device-type fleets generate configs for the selected type rather than the fleet's own device type.

#### Scenario: Mixed fleet

- **WHEN** a fleet of device type A is used to provision a device of type B
- **THEN** the generated config is built from device type B's device-type json
