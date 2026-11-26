import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  limitSuite,
  makeSession,
  refusedBy,
  type SessionFixture,
  setLimit,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { first, run } from '../../platform/db.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { addMembership, type Kit, makeKit } from './test-kit.ts';

let kit: Kit;
let session: SessionFixture;
let app: ReturnType<typeof createApp>;
let n = 0;

beforeAll(async () => {
  kit = await makeKit();
  session = await makeSession(kit, { userId: kit.actor.id, roles: ['admin', 'user'] });
  await addMembership(kit, kit.actor.id, ['org_admin']);
  app = createApp({
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(kit.env, kit.clock),
      apiKeys: createApiKeyStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
});
afterAll(() => vi.restoreAllMocks());

const create = () =>
  app.request(
    '/api/v1/connections',
    {
      method: 'POST',
      headers: { ...session.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: kit.org.id,
        connectorType: 'http-json',
        name: `Members ${++n}`,
        config: { baseUrl: 'https://api.example.com/v1' },
        secrets: { token: 'tok-api-secret-xyz' },
      }),
    },
    kit.env,
  );

const held = async () =>
  (
    await first<{ n: number }>(
      kit.env.DB,
      'SELECT COUNT(*) AS n FROM connections WHERE org_id = ?',
      [kit.org.id],
    )
  )?.n ?? 0;

limitSuite('connections', async () => ({
  db: kit.env.DB,
  orgId: kit.org.id,
  key: 'connections',
  create: async () => refusedBy(await create()),
  count: held,
}));

describe('connection limits', () => {
  it('a refused create leaves no credential behind', async () => {
    const before = await held();
    await setLimit(kit.env.DB, kit.org.id, 'connections', before);
    const credentials = async () =>
      (await first<{ n: number }>(kit.env.DB, 'SELECT COUNT(*) AS n FROM credentials'))?.n ?? 0;
    const secrets = await credentials();
    expect((await refusedBy(await create()))?.code).toBe('FEATURE_LIMIT_REACHED');
    expect(await credentials()).toBe(secrets);
  });

  it('refuses a connector the plan does not list', async () => {
    await run(kit.env.DB, 'UPDATE org_entitlements SET preset = ? WHERE org_id = ?', [
      'trial',
      kit.org.id,
    ]);
    await run(kit.env.DB, 'DELETE FROM connections WHERE org_id = ?', [kit.org.id]);
    const refused = await refusedBy(await create());
    expect(refused?.code).toBe('FEATURE_NOT_INCLUDED');
    expect(await held()).toBe(0);
  });
});
