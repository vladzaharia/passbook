import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  makeApiKey,
  makeSession,
  refusedBy,
  type SessionFixture,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { first, run } from '../../platform/db.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { type ConnectionRow, getConnection, insertConnection } from './repo.ts';
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

const override = (items: string[]) =>
  run(
    kit.env.DB,
    `INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, updated_at)
     VALUES (?, 'connectors', ?, 1)`,
    [kit.org.id, JSON.stringify(items)],
  );
const credentials = async () =>
  (await first<{ n: number }>(kit.env.DB, 'SELECT COUNT(*) AS n FROM credentials'))?.n ?? 0;
const code = async (res: Response) => ((await res.json()) as { code: string }).code;

describe('connector plans', () => {
  it('keeps an existing connection, and its detail, when the org drops to trial', async () => {
    await onPreset('legacy');
    const made = await createRest();
    expect(made.status).toBe(201);
    const { id } = (await made.json()) as { id: string };
    try {
      await onPreset('trial');
      expect((await get(`/api/v1/connections/${id}`)).status).toBe(200);
      const listed = (await (await get(`/api/v1/connections?orgId=${kit.org.id}`)).json()) as {
        items: { id: string }[];
      };
      expect(listed.items.map((c) => c.id)).toContain(id);
      const detail = await get(`/api/v1/connectors/http-json?orgId=${kit.org.id}`);
      expect(detail.status).toBe(200);
      expect(((await detail.json()) as { entitled: boolean }).entitled).toBe(false);
      const sender = (await (
        await get(`/api/v1/connectors/webhook-push?orgId=${kit.org.id}`)
      ).json()) as { entitled: boolean; recipes: { entitled: boolean }[] };
      expect(sender.entitled).toBe(true);
      expect(sender.recipes.length).toBeGreaterThan(1);
      await override(['webhook-push/stripe-payments']);
      const only = (await (
        await get(`/api/v1/connectors/webhook-push?orgId=${kit.org.id}`)
      ).json()) as { entitled: boolean; recipes: { id: string; entitled: boolean }[] };
      expect(only.entitled).toBe(false);
      expect(only.recipes.length).toBeGreaterThan(1);
      expect(only.recipes.filter((r) => r.entitled).map((r) => r.id)).toEqual(['stripe-payments']);
    } finally {
      await run(kit.env.DB, "DELETE FROM org_entitlement_overrides WHERE key = 'connectors'");
      await run(kit.env.DB, 'DELETE FROM connections WHERE id = ?', [id]);
    }
  });

  it('shows a trial org no REST API and refuses to create one', async () => {
    await onPreset('trial');
    const items = await types();
    expect(items.map((c) => c.type).sort()).toEqual([
      'csv-url',
      'demo',
      'file-upload',
      'webhook-push',
    ]);
    expect(items.find((c) => c.type === 'webhook-push')?.recipes.length).toBeGreaterThan(1);
    const before = await credentials();
    const refused = await refusedBy(await createRest());
    expect(refused?.status).toBe(403);
    expect(refused?.code).toBe('FEATURE_NOT_INCLUDED');
    expect(await credentials()).toBe(before);
    const demo = await create('demo', {});
    expect(demo.status).toBe(201);
    await run(kit.env.DB, 'DELETE FROM connections WHERE id = ?', [
      ((await demo.json()) as { id: string }).id,
    ]);
  });

  it('lists only the entitled recipes of a connector', async () => {
    await onPreset('legacy');
    try {
      await override(['webhook-push/stripe-payments']);
      const items = await types();
      expect(items.map((c) => c.type)).toEqual(['webhook-push']);
      expect(items[0]?.recipes.map((r) => r.id)).toEqual(['stripe-payments']);
    } finally {
      await run(kit.env.DB, "DELETE FROM org_entitlement_overrides WHERE key = 'connectors'");
    }
  });

  it('creates only the senders a recipe-only plan names', async () => {
    await onPreset('legacy');
    const sender = (config: Record<string, unknown>, secrets: Record<string, string> = {}) =>
      create('webhook-push', config, secrets);
    let created: string | undefined;
    try {
      await override(['webhook-push/stripe-payments']);
      const ok = await app.request(
        '/api/v1/connections',
        {
          method: 'POST',
          headers: { ...session.headers, 'content-type': 'application/json' },
          body: JSON.stringify({
            orgId: kit.org.id,
            connectorType: 'webhook-push',
            name: 'Stripe',
            config: { recipe: 'stripe-payments' },
            mode: 'webhook',
            webhookSecret: `whsec_${crypto.randomUUID()}`,
          }),
        },
        kit.env,
      );
      expect(ok.status).toBe(201);
      created = ((await ok.json()) as { id: string }).id;
      for (const config of [{}, { recipe: 'custom' }, { recipe: 'shopify-orders' }]) {
        const res = await sender(config);
        expect(res.status).toBe(403);
        expect(await code(res)).toBe('FEATURE_NOT_INCLUDED');
      }
    } finally {
      await run(kit.env.DB, "DELETE FROM org_entitlement_overrides WHERE key = 'connectors'");
      if (created) await run(kit.env.DB, 'DELETE FROM connections WHERE id = ?', [created]);
    }
  });

  it('reads a bare sender type on a plan as all its recipes', async () => {
    await onPreset('legacy');
    try {
      await override(['webhook-push']);
      const [item] = await types();
      expect(item?.recipes.length).toBeGreaterThan(1);
      const res = await create('webhook-push', { recipe: 'shopify-orders' });
      expect(res.status).not.toBe(403);
    } finally {
      await run(kit.env.DB, "DELETE FROM org_entitlement_overrides WHERE key = 'connectors'");
    }
  });

  it('gates the unsaved test the same way', async () => {
    await onPreset('trial');
    const res = await app.request(
      '/api/v1/connections/test-config',
      {
        method: 'POST',
        headers: { ...session.headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          orgId: kit.org.id,
          connectorType: 'http-json',
          config: { baseUrl: 'https://api.example.com/v1' },
          secrets: { token: 'tok-api-secret-xyz' },
        }),
      },
      kit.env,
    );
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('FEATURE_NOT_INCLUDED');
  });

  it('refuses the preview of an unsaved config the same way', async () => {
    await onPreset('trial');
    const res = await app.request(
      '/api/v1/connections/test-config?preview=true',
      {
        method: 'POST',
        headers: { ...session.headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          orgId: kit.org.id,
          connectorType: 'http-json',
          config: { baseUrl: 'https://api.example.com/v1' },
          secrets: { token: 'tok-api-secret-xyz' },
        }),
      },
      kit.env,
    );
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('FEATURE_NOT_INCLUDED');
  });

  it('refuses the insert itself on a trial org and leaves no row', async () => {
    await onPreset('legacy');
    const made = await createRest();
    expect(made.status).toBe(201);
    const { id } = (await made.json()) as { id: string };
    const row = await getConnection(kit.env.DB, id);
    expect(row).not.toBeNull();
    await run(kit.env.DB, 'DELETE FROM connections WHERE id = ?', [id]);
    await onPreset('trial');
    const again = kit.sctx.ids.id();
    await expect(
      insertConnection(kit.sctx, { ...(row as ConnectionRow), id: again }, { orgId: kit.org.id }),
    ).rejects.toMatchObject({ code: 'FEATURE_NOT_INCLUDED' });
    expect(await getConnection(kit.env.DB, again)).toBeNull();
  });

  it('keeps a downgraded REST connection editable but not movable to a new origin', async () => {
    await onPreset('legacy');
    const made = await createRest();
    expect(made.status).toBe(201);
    const { id } = (await made.json()) as { id: string };
    const patch = (config: Record<string, unknown>, secrets?: Record<string, string>) =>
      app.request(
        `/api/v1/connections/${id}`,
        {
          method: 'PATCH',
          headers: { ...session.headers, 'content-type': 'application/json' },
          body: JSON.stringify({ config, ...(secrets ? { secrets } : {}) }),
        },
        kit.env,
      );
    try {
      await onPreset('trial');
      const same = await patch({ baseUrl: 'https://api.example.com/v2' });
      expect(same.status).toBe(200);
      const moved = await patch(
        { baseUrl: 'https://other.example.org/v1' },
        { token: 'tok-new-secret-abc' },
      );
      expect(moved.status).toBe(403);
      expect(await code(moved)).toBe('FEATURE_NOT_INCLUDED');
      const stored = await getConnection(kit.env.DB, id);
      expect(stored?.config).toMatchObject({ baseUrl: 'https://api.example.com/v2' });
    } finally {
      await run(kit.env.DB, 'DELETE FROM connections WHERE id = ?', [id]);
    }
  });

  it('shows a platform admin with no org everything', async () => {
    await onPreset('trial');
    const all = (await (await get('/api/v1/connectors')).json()) as {
      items: { type: string; entitled: boolean }[];
    };
    expect(all.items.map((c) => c.type).sort()).toEqual([
      'csv-url',
      'demo',
      'file-upload',
      'http-json',
      'webhook-push',
    ]);
    expect(all.items.every((c) => c.entitled)).toBe(true);
    expect((await get('/api/v1/connectors/http-json')).status).toBe(200);
  });

  it('filters an org key by its own org without an orgId', async () => {
    await onPreset('trial');
    const key = await makeApiKey(kit, { orgId: kit.org.id, scopes: ['connections:read'] });
    const res = await app.request('/api/v1/connectors', { headers: key.headers }, kit.env);
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: { type: string }[] };
    expect(items.map((c) => c.type).sort()).toEqual([
      'csv-url',
      'demo',
      'file-upload',
      'webhook-push',
    ]);
  });
});
