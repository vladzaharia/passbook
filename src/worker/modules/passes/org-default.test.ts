import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, fixtures, makeEnv, makeOrg } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import type { ApiScope } from '../../platform/auth.ts';
import { ManualClock } from '../../platform/clock.ts';

/**
 * The contract hides `orgId` from org-bound keys (`x-platform-only`): an org key leaves it out and acts in its
 * own org, naming another org is a 403, and a platform key still has to name one. Every operation below
 * resolves it through `orgIdOf`; this fails when one goes back to requiring it.
 */
const ID = '0193a1b2-7c00-7000-8000-0000000000e1';
const RELEASE = 'mode=test&provider=apple';

interface Route {
  op: string;
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  scope: ApiScope;
  query?: string;
  body?: unknown;
  /** api-keys answers a missing org with 400, from its router. */
  missing?: 400 | 422;
}

const ROUTES: Route[] = [
  {
    op: 'api-keys.getApiKeys',
    method: 'GET',
    path: '/api-keys',
    scope: 'api-keys:write',
    missing: 400,
  },
  {
    op: 'api-keys.getApiKeysById',
    method: 'GET',
    path: `/api-keys/${ID}`,
    scope: 'api-keys:write',
    missing: 400,
  },
  {
    op: 'api-keys.getApiKeysByIdActivity',
    method: 'GET',
    path: `/api-keys/${ID}/activity`,
    scope: 'api-keys:write',
    missing: 400,
  },
  {
    op: 'api-keys.deleteApiKeysById',
    method: 'DELETE',
    path: `/api-keys/${ID}`,
    scope: 'api-keys:write',
    missing: 400,
  },
  { op: 'connectors.getConnectors', method: 'GET', path: '/connectors', scope: 'connections:read' },
  {
    op: 'connectors.getConnectorsByType',
    method: 'GET',
    path: '/connectors/http-json',
    scope: 'connections:read',
  },
  {
    op: 'offboard.postOffboard',
    method: 'POST',
    path: '/offboard',
    scope: 'passes:write',
    body: { externalId: 'x', dryRun: true },
  },
  {
    op: 'passes.getPassesBulkPrintByJobId',
    method: 'GET',
    path: `/passes/bulk-print/${ID}`,
    scope: 'passes:write',
  },
  {
    op: 'passes.getPassesBulkPrintByJobIdPdf',
    method: 'GET',
    path: `/passes/bulk-print/${ID}/pdf`,
    scope: 'passes:write',
  },
  { op: 'holders.getHolders', method: 'GET', path: '/holders', scope: 'passes:read' },
  { op: 'broadcasts.getBroadcasts', method: 'GET', path: '/broadcasts', scope: 'messages:write' },
  { op: 'sandbox.getTestInbox', method: 'GET', path: '/test-inbox', scope: 'passes:read' },
  {
    op: 'sandbox.getTestInboxById',
    method: 'GET',
    path: `/test-inbox/${ID}`,
    scope: 'passes:read',
  },
  {
    op: 'templates.getTemplatesByIdCandidates',
    method: 'GET',
    path: `/templates/${ID}/candidates`,
    scope: 'templates:read',
    query: RELEASE,
  },
  {
    op: 'templates.getTemplatesByIdReleases',
    method: 'GET',
    path: `/templates/${ID}/releases`,
    scope: 'templates:read',
    query: RELEASE,
  },
  {
    op: 'templates.getTemplatesByIdReleasesImpact',
    method: 'GET',
    path: `/templates/${ID}/releases/impact`,
    scope: 'templates:read',
    query: `${RELEASE}&version=1`,
  },
  {
    op: 'templates.getTemplatesEligible',
    method: 'GET',
    path: '/templates/eligible',
    scope: 'templates:read',
    query: RELEASE,
  },
];

const auth = fakeAuth('https://wallet.test');
let app: ReturnType<typeof createApp>;
let env: Awaited<ReturnType<typeof makeEnv>>;
let org: { id: string };
let other: { id: string };

beforeAll(async () => {
  const clock = new ManualClock(1_800_000_000_000);
  env = await makeEnv();
  const f = fixtures(env, clock);
  auth.bindApiKeys(env, clock);
  app = createApp({ stores: auth.stores, clock });
  org = await makeOrg(f);
  other = await makeOrg(f);
}, 30_000);

function send(r: Route, headers: Record<string, string>, orgId?: string) {
  const query = [r.query, orgId ? `orgId=${orgId}` : undefined].filter(Boolean).join('&');
  return app.request(
    `https://wallet.test/api/v1${r.path}${query ? `?${query}` : ''}`,
    {
      method: r.method,
      headers: {
        ...headers,
        ...(r.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(r.body === undefined ? {} : { body: JSON.stringify(r.body) }),
    },
    env,
  );
}

describe.each(ROUTES)('$op', (r) => {
  const keyOf = (orgId: string | null) => auth.apiKey({ orgId, scopes: [r.scope], mode: 'test' });

  it('lets an org key leave orgId out', async () => {
    const res = await send(r, keyOf(org.id));
    expect([200, 404]).toContain(res.status);
    expect(((await res.clone().json()) as { code?: string } | null)?.code).not.toBe('ORG_REQUIRED');
  });

  it('refuses an org key that names another org', async () => {
    expect((await send(r, keyOf(org.id), other.id)).status).toBe(403);
  });

  it('still asks a platform key for an org', async () => {
    const res = await send(r, keyOf(null));
    expect(res.status).toBe(r.missing ?? 422);
  });
});

describe('passes.postPassesPhotosMatch (orgId in the body)', () => {
  const post = (orgId: string | null, body: object) =>
    app.request(
      'https://wallet.test/api/v1/passes/photos/match',
      {
        method: 'POST',
        headers: {
          ...auth.apiKey({ orgId, scopes: ['passes:write'], mode: 'test' }),
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      env,
    );

  it('lets an org key leave orgId out', async () => {
    expect((await post(org.id, { keys: ['a'] })).status).toBe(200);
  });

  it('still asks a platform key for an org', async () => {
    const res = await post(null, { keys: ['a'] });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code?: string }).code).toBe('ORG_REQUIRED');
  });
});
