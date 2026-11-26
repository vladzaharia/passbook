import { beforeEach, describe, expect, it } from 'vitest';
import { makeApiKey, makeOrg, makeSession } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { getConnection } from './repo.ts';
import { addMembership, createDemo, type Kit, makeKit } from './test-kit.ts';
import { recordArrival } from './webhook-arrivals.ts';

let kit: Kit;
let app: ReturnType<typeof createApp>;
let headers: Record<string, string>;
let id: string;

beforeEach(async () => {
  kit = await makeKit();
  headers = (await makeSession(kit, { userId: kit.actor.id, roles: ['admin', 'user'] })).headers;
  await addMembership(kit, kit.actor.id, ['org_admin']);
  app = createApp({
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(kit.env, kit.clock),
      apiKeys: createApiKeyStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
  id = (
    await createDemo(kit, { connectorType: 'webhook-push', config: {}, mode: 'webhook' } as never)
  ).id;
  const conn = await getConnection(kit.env.DB, id);
  if (!conn) throw new Error('missing connection');
  const req = new Request('https://wallet.test/x', { method: 'POST' });
  await recordArrival(kit.sctx, conn, req, { outcome: 'rejected', reason: 'signature_missing' });
  kit.clock.advance(1000);
  await recordArrival(kit.sctx, conn, req, { outcome: 'ignored', reason: 'ping' });
});

const get = (path: string, h: Record<string, string> = headers) =>
  app.request(`/api/v1/connections/${id}/webhook-arrivals${path}`, { headers: h }, kit.env);

describe('GET /connections/{id}/webhook-arrivals', () => {
  it('lists the rows newest first, filters by since and answers 304 for an unchanged list', async () => {
    const res = await get('');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { reason: string; lastAt: number }[];
      nextCursor: null;
    };
    expect(body.items.map((r) => r.reason)).toEqual(['ping', 'signature_missing']);
    const since = body.items[1]?.lastAt ?? 0;
    expect(((await (await get(`?since=${since}`)).json()) as typeof body).items).toHaveLength(1);
    const etag = res.headers.get('etag') ?? '';
    expect(etag).not.toBe('');
    const again = await get('', { ...headers, 'if-none-match': etag });
    expect(again.status).toBe(304);
  });

  it('refuses a key without connections:read and a user of another org', async () => {
    const weak = await makeApiKey(kit, { orgId: kit.org.id, scopes: ['passes:write'] });
    expect((await get('', weak.headers)).status).toBe(403);
    const ok = await makeApiKey(kit, { orgId: kit.org.id, scopes: ['connections:read'] });
    expect((await get('', ok.headers)).status).toBe(200);
    const other = await makeOrg(kit);
    const foreign = await makeApiKey(kit, { orgId: other.id, scopes: ['connections:read'] });
    expect([403, 404]).toContain((await get('', foreign.headers)).status);
  });

  it('validates the query', async () => {
    expect((await get('?limit=500')).status).toBe(422);
  });
});
