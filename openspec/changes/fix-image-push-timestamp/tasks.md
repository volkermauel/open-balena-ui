- [x] 1. `createImage` in `server/controller/supervisorRelease/instance.ts`: add
     `push_timestamp: new Date().toISOString()` to the POST body (keep `start_timestamp`)
- [x] 2. Tests: extend a supervisor-seed and a hostos-seed test (or add small focused ones) to assert the image POST
     payload contains `status: 'success'`, `start_timestamp`, and `push_timestamp`
     - No existing test captured the image POST payload (the seed tests only assert step plans), so a focused one was
       added: `tests/supervisorRelease/instance.test.ts` — both seed flows call the same shared `createImage`, so the
       single payload assertion covers supervisor and hostOS seeding
- [x] 3. `npm test` green
