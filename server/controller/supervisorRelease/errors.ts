/**
 * Typed errors for the supervisor release feature.
 * Routes map these to HTTP responses with the `{ success: false, message }` shape
 * used by the other UI server routes.
 */

/** balenaCloud (catalog) or a source registry could not be read from / copied from. */
export class UpstreamError extends Error {
  /** HTTP status of the failing upstream response when one was received. */
  public readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
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

/**
 * A supervisor version/tag does not exist on the configured mirror repository:
 * it must be built and published there first (the mirror repository's
 * supervisor workflow). Extends NotFoundError so routes render it as a 404.
 */
export class SupervisorTagMissingError extends NotFoundError {
  constructor(what: string, repo: string, sourceUrl: string) {
    super(
      `Supervisor ${what} not found on the source mirror ${sourceUrl.replace(/^https?:\/\//, '')}/${repo} — ` +
        'build and publish it via the supervisor workflow of the mirror repository ' +
        '(SUPERVISOR_SOURCE_REGISTRY)',
    );
    this.name = 'SupervisorTagMissingError';
  }
}

/** The instance registry rejected or failed a mirror operation. */
export class RegistryMirrorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryMirrorError';
  }
}
