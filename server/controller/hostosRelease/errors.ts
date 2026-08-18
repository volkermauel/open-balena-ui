import {
  InstanceApiError,
  MirroringNotConfiguredError,
  NotFoundError,
  RegistryMirrorError,
  UpstreamError,
} from '../supervisorRelease/errors';

/**
 * Typed errors for the hostOS release feature. Routes map these to HTTP
 * responses with the `{ success: false, message }` shape used by the other UI
 * server routes; the shared registry/instance errors are re-exported so the
 * route layer only needs this module.
 */

export { InstanceApiError, MirroringNotConfiguredError, NotFoundError, RegistryMirrorError, UpstreamError };

/** `HOSTOS_SOURCE_REGISTRY` cannot be parsed into a registry host + repository path. */
export class HostosNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostosNotConfiguredError';
  }
}
