## Summary

The OS-download wizard's fleet dropdown filters fleets by the selected device type and resets the selection when the
device type changes. Fleets with mixed device types (e.g. raspberrypi4-64 and raspberrypi5 enrolled in one fleet) are
legitimate on this instance — the filter hides them and the reset unselects a deliberately chosen fleet.

## Why

openBalena allows enrolling devices of a different type into an existing fleet. Provisioning an OS image for such a
fleet requires choosing the image's device type independently of the fleet.

## What Changes

- The fleet dropdown lists all fleets (no `is for-device type` filtering).
- Changing the device type never resets or changes the fleet selection.
- Launching from a fleet still preselects it and its device type as the default.

## Impact

- `src/ui/OsDownloadDialog.tsx`, `src/lib/osImage.ts` (helper removed), `tests/osImage/fleets.test.ts`
