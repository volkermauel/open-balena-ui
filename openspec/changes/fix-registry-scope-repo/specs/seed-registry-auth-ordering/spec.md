# fix-registry-scope-repo — spec deltas

## ADDED Requirements

### Requirement: Registry tokens use location-derived repository names

All instance-registry operations (token scopes, manifest/blob reads and writes, verification) SHALL address repositories
by the name derived from the image location minus the registry host (`v2/<name>`). A repository name consisting of a
single path segment SHALL be considered a bug: the instance API's token endpoint cannot grant scopes for such names and
the registry will answer 401.

#### Scenario: Fresh hostOS import

- **WHEN** a hostOS version is imported and the instance API assigns the image a location `<host>/v2/<hash>`
- **THEN** the mirror requests scope `repository:v2/<hash>:pull,push`, writes to `/v2/v2/<hash>/…`, and the manifest
  existence check succeeds (200/404, never 401)
