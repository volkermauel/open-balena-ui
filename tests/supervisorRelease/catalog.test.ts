import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import {
  listMirrorVersions,
  mirrorTagsToVersions,
  serviceNameForVersion,
} from '../../server/controller/supervisorRelease/cloud';
import { UpstreamError } from '../../server/controller/supervisorRelease/errors';
import { resetRegistryTokens } from '../../server/controller/supervisorRelease/registryMirror';

/**
 * Mirror-tag catalog against a fully mocked ghcr + balenaCloud: anonymous
 * token, tags/list, best-effort cloud enrichment. No network.
 */

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
}

const calls: Recorded[] = [];

/** What the mocked balenaCloud catalog serves (defaults: unreachable). */
const cloudState = {
  reachable: true,
  applicationId: 4242,
  /** semver → { id, variant } */
  releases: new Map<string, { id: number; variant: string }>([['19.0.9', { id: 30, variant: 'prod' }]]),
  /** release id → service name */
  serviceNames: new Map<number, string>([[30, 'core']]),
};

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const installFetchMock = (tags: string[] | number): void => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(new Headers((init?.headers as HeadersInit) ?? {}).entries()) as Record<
      string,
      string
    >;
    calls.push({ method, url, headers });

    // Anonymous source pull token — never a credential.
    if (url.startsWith('https://ghcr.io/token')) {
      return jsonResponse(200, { token: 'source-token' });
    }

    // Mirror tags/list (404 = repository does not exist → empty arch).
    if (url.startsWith('https://ghcr.io/v2/')) {
      if (typeof tags === 'number') {
        return jsonResponse(tags, { errors: [{ message: 'upstream boom' }] });
      }
      return jsonResponse(200, { name: 'volkermauel/aarch64-supervisor', tags });
    }

    // balenaCloud public catalog (enrichment).
    if (url.startsWith('https://api.balena-cloud.com/')) {
      if (!cloudState.reachable) {
        return jsonResponse(500, { error: { text: 'catalog down' } });
      }
      if (url.includes('/v6/application')) {
        return jsonResponse(200, { d: [{ id: cloudState.applicationId, slug: 'balena_os/aarch64-supervisor' }] });
      }
      if (url.includes('/v6/release?')) {
        return jsonResponse(200, {
          d: [...cloudState.releases.entries()].map(([semver, release]) => ({
            id: release.id,
            raw_version: `${semver}-1786970539365`,
            semver,
            variant: release.variant,
            composition: {},
          })),
        });
      }
      if (url.includes('/v6/release_image')) {
        const releaseId = Number(/release%20eq%20(\d+)/.exec(url)?.[1] ?? 0);
        const serviceName = cloudState.serviceNames.get(releaseId) ?? 'supervisor';
        return jsonResponse(200, {
          d: [
            {
              image: {
                is_stored_at__image_location: 'registry2.balena-cloud.com/v2/abc',
                content_hash: 'sha256:' + 'a'.repeat(64),
                is_a_build_of__service: [{ service_name: serviceName }],
              },
            },
          ],
        });
      }
    }

    return jsonResponse(500, { errors: [{ message: `unmocked ${method} ${url}` }] });
  }) as typeof fetch;
};

const restoreFetch = (): void => {
  delete (globalThis as { fetch?: typeof fetch }).fetch;
};

const run = async <T>(work: () => Promise<T>): Promise<T> => {
  installFetchMock(['v19.0.9', '19.0.9', 'v19.0.8', 'latest', 'edge-abc']);
  try {
    return await work();
  } finally {
    restoreFetch();
  }
};

beforeEach(() => {
  calls.length = 0;
  cloudState.reachable = true;
  resetRegistryTokens();
  delete process.env.SUPERVISOR_SOURCE_REGISTRY;
  delete process.env.BALENACLOUD_API_URL;
});

test('mirror tags become ordered, deduped versions preferring the v-prefixed raw tag', () => {
  const versions = mirrorTagsToVersions(['v19.0.9', '19.0.9', '19.0.10', 'v19.0.8', '19.0.8+rev1', 'latest', 'x']);
  const bySemver = new Map(versions.map((entry) => [entry.semver, entry]));

  // Semver-descending, newest first; a build-suffixed spelling is its own version.
  assert.deepEqual(
    versions.map((entry) => entry.semver),
    ['19.0.10', '19.0.9', '19.0.8+rev1', '19.0.8'],
  );
  // Dedupe by semver keeps the `v`-prefixed raw tag.
  assert.equal(bySemver.get('19.0.9')?.mirrorTag, 'v19.0.9');
  assert.equal(bySemver.get('19.0.9')?.rawVersion, 'v19.0.9');
  assert.equal(bySemver.get('19.0.8')?.mirrorTag, 'v19.0.8');
  // Unknown-to-cloud entries carry the defaults.
  assert.equal(bySemver.get('19.0.10')?.cloudReleaseId, 0);
  assert.equal(bySemver.get('19.0.10')?.variant, '');
  assert.equal(bySemver.get('19.0.10')?.serviceName, 'supervisor');
});

test('the mirror catalog lists tags anonymously and enriches from the cloud catalog', async () => {
  const versions = await run(() => listMirrorVersions('aarch64'));

  // Anonymous token: no Authorization header, scope names the per-arch repo.
  const tokenRequest = calls.find((call) => call.url.startsWith('https://ghcr.io/token'))!;
  assert.equal(tokenRequest.headers['authorization'], undefined);
  assert.match(tokenRequest.url, /scope=repository%3Avolkermauel%2Faarch64-supervisor%3Apull/);

  const tagsRequest = calls.find((call) => call.url.includes('/v2/volkermauel/aarch64-supervisor/tags/list'))!;
  assert.ok(tagsRequest, 'tags are listed from the per-arch mirror repository');
  assert.match(tagsRequest.url, /n=1000/);
  assert.equal(tagsRequest.headers['authorization'], 'Bearer source-token');

  assert.equal(versions.length, 2);
  // Enriched: variant + cloud release id attached, mirror identity untouched.
  assert.equal(versions[0].semver, '19.0.9');
  assert.equal(versions[0].variant, 'prod');
  assert.equal(versions[0].cloudReleaseId, 30);
  assert.equal(versions[0].mirrorTag, 'v19.0.9');
  // Unknown to the cloud catalog: defaults, still listed.
  assert.equal(versions[1].semver, '19.0.8');
  assert.equal(versions[1].variant, '');
  assert.equal(versions[1].cloudReleaseId, 0);
});

test('an arch without a mirror repository lists as empty (tags 404)', async () => {
  installFetchMock(404);
  try {
    assert.deepEqual(await listMirrorVersions('amd64'), []);
  } finally {
    restoreFetch();
  }
});

test('a registry refusing the anonymous token for a missing repo lists as empty', async () => {
  globalThis.fetch = (async () => jsonResponse(401, {})) as typeof fetch;
  try {
    assert.deepEqual(await listMirrorVersions('armv7hf'), []);
  } finally {
    restoreFetch();
  }
});

test('a failing tags request raises an upstream error naming the source registry', async () => {
  installFetchMock(500);
  try {
    await assert.rejects(
      () => listMirrorVersions('aarch64'),
      (error: unknown) => error instanceof UpstreamError && error.message.includes('ghcr.io'),
    );
  } finally {
    restoreFetch();
  }
});

test('an unreachable enrichment catalog never fails the listing', async () => {
  cloudState.reachable = false;
  const versions = await run(() => listMirrorVersions('aarch64'));

  assert.equal(versions.length, 2);
  assert.equal(versions[0].variant, '');
  assert.equal(versions[0].cloudReleaseId, 0);
  assert.equal(versions[0].serviceName, 'supervisor');
});

test('service names come from the cloud catalog when known, defaulting to supervisor', async () => {
  const names = await run(async () => {
    const versions = await listMirrorVersions('aarch64');
    const enriched = versions.find((entry) => entry.semver === '19.0.9')!;
    const unknown = versions.find((entry) => entry.semver === '19.0.8')!;
    return {
      enriched: await serviceNameForVersion(enriched),
      unknown: await serviceNameForVersion(unknown),
    };
  });

  assert.equal(names.enriched, 'core');
  assert.equal(names.unknown, 'supervisor');

  // Even a failing images query must not throw.
  globalThis.fetch = (async () => jsonResponse(500, {})) as typeof fetch;
  try {
    assert.equal(
      await serviceNameForVersion({
        semver: '19.0.9',
        rawVersion: 'v19.0.9',
        mirrorTag: 'v19.0.9',
        cloudReleaseId: 30,
        variant: 'prod',
        serviceName: 'supervisor',
      }),
      'supervisor',
    );
  } finally {
    restoreFetch();
  }
});
