/**
 * Typed errors for the supervisor release feature.
 * Routes map these to HTTP responses with the `{ success: false, message }` shape
 * used by the other UI server routes.
 */

/** balenaCloud (catalog or registry) could not be read from / copied from. */
export class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamError';
  }
}

/** A requested entity (device type, supervisor version, ...) does not exist. */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** The openBalena instance API returned an unexpected response. */
export class InstanceApiError extends Error {
  public readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = 'InstanceApiError';
    this.status = status;
  }
}

/** `BALENACLOUD_TOKEN` is not configured: listing works, seeding/mirroring cannot. */
export class MirroringNotConfiguredError extends Error {
  constructor() {
    super(
      'Supervisor image mirroring is not configured: set the BALENACLOUD_TOKEN environment variable ' +
        '(a balenaCloud JWT with registry pull access) on the open-balena-ui server.',
    );
    this.name = 'MirroringNotConfiguredError';
  }
}

/** The instance registry rejected or failed a mirror operation. */
export class RegistryMirrorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryMirrorError';
  }
}
