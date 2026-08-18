- [ ] 1. `OsDownloadDialog.tsx`: remove `fleetMatchesDeviceType` import, render `fleets` instead of `visibleFleets`,
     delete the device-type-change reset effect
- [ ] 2. `src/lib/osImage.ts`: remove `fleetMatchesDeviceType` (unused after 1)
- [ ] 3. `tests/osImage/fleets.test.ts`: drop the device-type-match test; keep merge tests
- [ ] 4. `npm test`, `npx tsc --noEmit`, `npx prettier --check .` green;
     `openspec validate os-download-mixed-fleets --strict` passes
