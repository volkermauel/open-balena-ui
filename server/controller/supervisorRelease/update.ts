import { InstanceApiError } from './errors';
import { InstanceAuth, patchDeviceSupervisorRelease } from './instance';
import { SeedResult, seedSupervisorRelease } from './seed';

/**
 * Ensure a supervisor version is seeded (seeds on first use) and set it as the
 * target supervisor release of each device with the caller's JWT. The
 * instance's pine hooks enforce the no-downgrade rule per device; failures are
 * collected per device so bulk updates tolerate partial failure.
 */

export interface DeviceUpdateResult {
  id: number;
  ok: boolean;
  message?: string;
}

export interface BulkUpdateSummary {
  total: number;
  updated: number;
  rejected: number;
}

/** Aggregate per-device results into a summary. Pure — unit tested. */
export const aggregateResults = (results: DeviceUpdateResult[]): BulkUpdateSummary => {
  const updated = results.filter((result) => result.ok).length;
  return { total: results.length, updated, rejected: results.length - updated };
};

export interface SupervisorUpdateOutcome {
  seed: SeedResult;
  results: DeviceUpdateResult[];
}

export const updateSupervisorReleases = async (
  auth: InstanceAuth,
  deviceTypeSlug: string,
  version: string,
  deviceIds: number[],
): Promise<SupervisorUpdateOutcome> => {
  // Ensures seeded (idempotent): seeds if the version is not on the instance yet.
  const seed = await seedSupervisorRelease(auth, deviceTypeSlug, version);

  const results: DeviceUpdateResult[] = [];
  for (const deviceId of deviceIds) {
    try {
      await patchDeviceSupervisorRelease(auth, deviceId, seed.releaseId);
      results.push({ id: deviceId, ok: true });
    } catch (error) {
      // e.g. the API's "Attempt to downgrade supervisor, which is not allowed"
      const message =
        error instanceof InstanceApiError || error instanceof Error ? error.message : 'Supervisor update rejected';
      results.push({ id: deviceId, ok: false, message });
    }
  }

  return { seed, results };
};
