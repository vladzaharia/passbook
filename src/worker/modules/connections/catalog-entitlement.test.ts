import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeSession, refusedBy, type SessionFixture } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { run } from '../../platform/db.ts';
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

const get = (path: string) => app.request(path, { headers: session.headers }, kit.env);
const create = (connectorType: string, config: Record<string, unknown>, secrets = {}) =>
  app.request(
    '/api/v1/connections',
    {
      method: 'POST',
      headers: { ...session.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: kit.org.id,
        connectorType,
        name: `Link ${++n}`,
        config,
        secrets,
      }),
    },
    kit.env,
  );
const createRest = () =>
  create('http-json', { baseUrl: 'https://api.example.com/v1' }, { token: 'tok-api-secret-xyz' });
const onPreset = (preset: string) =>
  run(kit.env.DB, 'UPDATE org_entitlements SET preset = ? WHERE org_id = ?', [preset, kit.org.id]);
const types = async () =>
  (
    (await (await get(`/api/v1/connectors?orgId=${kit.org.id}`)).json()) as {
      items: { type: string; recipes: { id: string }[] }[];
    }
  ).items;

describe('connector plans', () => {
  it('keeps an existing connection when the org drops to trial', async () => {
    await onPreset('legacy');
    const made = await createRest();
    expect(made.status).toBe(201);
    const { id } = (await made.json()) as { id: string };
    await onPreset('trial');
    expect((await get(`/api/v1/connections/${id}`)).status).toBe(200);
    const listed = (await (await get(`/api/v1/connections?orgId=${kit.org.id}`)).json()) as {
      items: { id: string }[];
    };
    expect(listed.items.map((c) => c.id)).toContain(id);
  });

  it('shows a trial org no REST API and refuses to create one', async () => {
    await onPreset('trial');
    const items = await types();
    expect(items.map((c) => c.type).sort()).toEqual(['csv-url', 'demo', 'webhook-push']);
    expect(items.find((c) => c.type === 'webhook-push')?.recipes.length).toBeGreaterThan(1);
    const denied = await get(`/api/v1/connectors/http-json?orgId=${kit.org.id}`);
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { code: string }).code).toBe('FEATURE_NOT_INCLUDED');
    // Fresh org slot: the limit check passes (the earlier connection is the one trial allows), so the allow-list refuses.
    await run(kit.env.DB, 'DELETE FROM connections WHERE org_id = ?', [kit.org.id]);
    const refused = await refusedBy(await createRest());
    expect(refused?.status).toBe(403);
    expect(refused?.code).toBe('FEATURE_NOT_INCLUDED');
    expect((await create('demo', {})).status).toBe(201);
  });

  it('lists only the entitled recipes of a connector', async () => {
    await onPreset('legacy');
    await run(
      kit.env.DB,
      `INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, updated_at)
       VALUES (?, 'connectors', '["webhook-push/stripe-payments"]', 1)`,
      [kit.org.id],
    );
    const items = await types();
    expect(items.map((c) => c.type)).toEqual(['webhook-push']);
    expect(items[0]?.recipes.map((r) => r.id)).toEqual(['stripe-payments']);
    await run(kit.env.DB, "DELETE FROM org_entitlement_overrides WHERE key = 'connectors'");
  });

  it('shows a platform admin with no org everything', async () => {
    await onPreset('trial');
    const all = (await (await get('/api/v1/connectors')).json()) as { items: { type: string }[] };
    expect(all.items.map((c) => c.type).sort()).toEqual([
      'csv-url',
      'demo',
      'http-json',
      'webhook-push',
    ]);
    expect((await get('/api/v1/connectors/http-json')).status).toBe(200);
  });
});
