- [ ] 1. `createImage` in `server/controller/supervisorRelease/instance.ts`: add
       `push_timestamp: new Date().toISOString()` to the POST body (keep `start_timestamp`)
- [ ] 2. Tests: extend a supervisor-seed and a hostos-seed test (or add small focused ones) to
       assert the image POST payload contains `status: 'success'`, `start_timestamp`, and
       `push_timestamp`
- [ ] 3. `npm test` green
