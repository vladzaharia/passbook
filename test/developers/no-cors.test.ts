import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/worker/app.ts';
import { ManualClock } from '../../src/worker/platform/clock.ts';
import type { AppEnv } from '../../src/worker/platform/env.ts';
import { createAuthStores } from '../../src/worker/stores.ts';
import { fixtures, makeApiKey, makeEnv, makeOrg, TEST_NOW } from '../helpers/index.ts';

// The developer portal shares the API's origin, so /api/v1 needs no CORS, and none may appear: a CORS grant would
// let any site's script read API answers with a pasted key or a try token (design-portal-platform.md, DP4).
const FOREIGN = 'https://evil.example';

let env: AppEnv;
let app: ReturnType<typeof createApp>;
let key: Record<string, string>;

beforeAll(async () => {
  const clock = new ManualClock(TEST_NOW);
  env = await makeEnv();
  const f = fixtures(env, clock);
  const org = await makeOrg(f);
  key = (await makeApiKey(f, { orgId: org.id, scopes: ['passes:read'] })).headers;
  app = createApp({ stores: createAuthStores(env, clock), clock });
});

const corsHeaders = (res: Response) =>
  [...res.headers.keys()].filter((name) => name.toLowerCase().startsWith('access-control-'));

describe('/api/v1 has no CORS', () => {
  it('answers a preflight with no Access-Control-* header', async () => {
    const res = await app.request(
      '/api/v1/passes',
      {
        method: 'OPTIONS',
        headers: {
          origin: FOREIGN,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization, content-type',
        },
      },
      env,
    );
    expect(corsHeaders(res)).toEqual([]);
  });

  it('sends none on a key call, a try-token call, a session route or the public document', async () => {
    const calls: [string, Record<string, string>][] = [
      ['/api/v1/passes', { ...key, origin: FOREIGN }],
      ['/api/v1/passes', key],
      ['/api/v1/passes', { authorization: 'Bearer pbtry_x.y', origin: FOREIGN }],
      ['/api/v1/developer/sandbox', { origin: FOREIGN }],
      ['/api/v1/openapi.json', { origin: FOREIGN }],
    ];
    for (const [path, headers] of calls) {
      const res = await app.request(path, { headers }, env);
      expect(corsHeaders(res), `${path} ${res.status}`).toEqual([]);
    }
  });
});
