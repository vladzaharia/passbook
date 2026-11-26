import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeSession, makeUser, type SessionFixture } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { addMembership, type Kit, makeKit } from './test-kit.ts';

const SECRET = 'shopify-signing-secret-0123456789';

let kit: Kit;
let session: SessionFixture;
let app: ReturnType<typeof createApp>;

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

const get = (path: string, headers = session.headers) => app.request(path, { headers }, kit.env);
const create = async (connectorType: string, config: Record<string, unknown>, extra = {}) => {
  const res = await app.request(
    '/api/v1/connections',
    {
      method: 'POST',
      headers: { ...session.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: kit.org.id,
        connectorType,
        name: `Link ${Math.random()}`,
        config,
        ...extra,
      }),
    },
    kit.env,
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
};

describe('GET /connectors/webhook-push/recipes/{recipe}/setup', () => {
  it.each([
    'custom',
    'shopify-orders',
    'shopify-customers',
    'stripe-subscriptions',
    'stripe-payments',
    'calcom-bookings',
    'woocommerce-orders',
    'tickettailor-tickets',
  ])('serves the %s guide with the fields unresolved', async (recipe) => {
    const res = await get(
      `/api/v1/connectors/webhook-push/recipes/${recipe}/setup?orgId=${kit.org.id}`,
    );
    expect(res.status).toBe(200);
    const guide = (await res.json()) as { recipe: string; direction: string; steps: unknown[] };
    expect(guide).toMatchObject({ recipe, direction: 'inbound' });
    expect(guide.steps.length).toBeGreaterThan(0);
    expect(guide).not.toHaveProperty('values');
  });

  it('refuses an unknown recipe, and a caller with no org', async () => {
    const unknown = await get(
      `/api/v1/connectors/webhook-push/recipes/nope/setup?orgId=${kit.org.id}`,
    );
    expect(unknown.status).toBe(422);
    const anon = await app.request(
      '/api/v1/connectors/webhook-push/recipes/custom/setup',
      {},
      kit.env,
    );
    expect(anon.status).toBe(401);
  });
});

describe('GET /connections/{id}/setup', () => {
  it('fills in the URL and never returns the secret', async () => {
    const id = await create(
      'webhook-push',
      { recipe: 'shopify-orders' },
      { mode: 'webhook', webhookSecret: SECRET },
    );
    const res = await get(`/api/v1/connections/${id}/setup`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    const body = JSON.parse(text) as {
      recipe: string;
      version: string;
      values: Record<string, unknown>;
    };
    expect(body.recipe).toBe('shopify-orders');
    expect(body.values).toEqual({
      endpointUrl: expect.stringMatching(new RegExp(`/hooks/connections/${id}$`)),
      signatureHeader: null,
      timestampHeader: null,
      hasSecret: true,
    });
  });

  it("gives a custom connection its header names, defaults or the connection's own", async () => {
    const plain = await create('webhook-push', {}, { mode: 'webhook' });
    const named = await create(
      'webhook-push',
      { signatureHeader: 'x-acme-sig', timestampHeader: 'x-acme-ts' },
      { mode: 'webhook' },
    );
    const values = async (id: string) =>
      ((await (await get(`/api/v1/connections/${id}/setup`)).json()) as { values: object }).values;
    expect(await values(plain)).toMatchObject({
      signatureHeader: 'x-wallet-signature',
      timestampHeader: 'x-wallet-timestamp',
    });
    expect(await values(named)).toMatchObject({
      signatureHeader: 'x-acme-sig',
      timestampHeader: 'x-acme-ts',
    });
  });

  it('has no guide for another connector, and hides the connection from a non-member', async () => {
    const demo = await create('demo', { count: 1 });
    const res = await get(`/api/v1/connections/${demo}/setup`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('CONNECTOR_NOT_FOUND');

    const hook = await create('webhook-push', {}, { mode: 'webhook' });
    const outsider = await makeSession(kit, {
      userId: (await makeUser(kit)).id,
      roles: ['admin', 'user'],
    });
    const hidden = await get(`/api/v1/connections/${hook}/setup`, outsider.headers);
    expect(hidden.status).toBe(404);
    expect(((await hidden.json()) as { code: string }).code).toBe('CONNECTION_NOT_FOUND');
  });
});

describe('GET /webhook-endpoints/setup', () => {
  it('serves the outbound guide, ahead of the by-id route', async () => {
    const res = await get(`/api/v1/webhook-endpoints/setup?orgId=${kit.org.id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ direction: 'outbound', recipe: 'outbound' });
  });

  it('needs an org and a member', async () => {
    expect((await get('/api/v1/webhook-endpoints/setup')).status).toBe(422);
    const outsider = await makeSession(kit, {
      userId: (await makeUser(kit)).id,
      roles: ['admin', 'user'],
    });
    const res = await get(`/api/v1/webhook-endpoints/setup?orgId=${kit.org.id}`, outsider.headers);
    expect(res.status).toBe(403);
  });
});
