import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, fixtures, makeEnv, makeOrg } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { all, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { isOrgActive } from './active.ts';

const fake = fakeAuth();
let appEnv: AppEnv;
const app = createApp({ stores: fake.stores });
const call = (method: string, path: string, body?: unknown, headers = fake.admin()) =>
  app.request(
    `/api/v1/orgs${path}`,
    {
      method,
      headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    },
    appEnv,
  );

beforeAll(async () => {
  appEnv = await makeEnv();
});

describe('orgs api', () => {
  it('rejects header-injection and bidi characters in the name', async () => {
    for (const name of ['Acme\r\nBcc: x@y.z', 'Acme\u202Eevil', 'A\u2028B']) {
      expect((await call('POST', '', { slug: 'inj-org', name })).status).toBe(422);
    }
    const ok = await call('POST', '', { slug: 'inj-ok', name: 'Acme' });
    expect(ok.status).toBe(201);
    const id = ((await ok.json()) as { id: string }).id;
    expect((await call('PATCH', `/${id}`, { name: 'Acme\r\nBcc: x@y.z' })).status).toBe(422);
  });

  it('requires an admin', async () => {
    expect((await call('GET', '', undefined, fake.user())).status).toBe(403);
    expect((await call('GET', '', undefined, {})).status).toBe(401);
    expect((await call('GET', '', undefined, fake.apiKey())).status).toBe(401);
  });

  it('creates, reads, updates and soft-deletes with audit rows', async () => {
    const created = await call('POST', '', {
      slug: 'acme',
      name: 'Acme',
      branding: { accent: '#112233' },
    });
    expect(created.status).toBe(201);
    const org = (await created.json()) as { id: string; status: string; branding: object };
    expect(org.status).toBe('active');
    expect(org.branding).toEqual({ accent: '#112233' });

    const got = await (await call('GET', `/${org.id}`)).json();
    expect(got).toMatchObject({
      slug: 'acme',
      counts: { passes: 0, templates: 0, connections: 0, apiKeys: 0 },
      countsCapped: false,
    });

    const patched = await call('PATCH', `/${org.id}`, { name: 'Acme Inc', status: 'suspended' });
    expect(await patched.json()).toMatchObject({ name: 'Acme Inc', status: 'suspended' });

    expect((await call('DELETE', `/${org.id}`)).status).toBe(200);
    expect((await call('GET', `/${org.id}`)).status).toBe(404);
    expect((await call('DELETE', `/${org.id}`)).status).toBe(404);

    const actions = await all<{ action: string; detail: string | null }>(
      env.DB,
      'SELECT action, detail FROM audit_log WHERE target_id = ? ORDER BY id',
      [org.id],
    );
    expect(actions.map((a) => a.action)).toEqual(['org.create', 'org.suspend', 'org.delete']);
    expect(JSON.parse(actions[1]?.detail ?? '{}').changes.name).toEqual({
      from: 'Acme',
      to: 'Acme Inc',
    });
  });

  it('rejects duplicate slugs, bad slugs and unknown identities', async () => {
    await call('POST', '', { slug: 'dup-org', name: 'One' });
    const dup = await call('POST', '', { slug: 'dup-org', name: 'Two' });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ code: 'ORG_SLUG_TAKEN' });
    expect((await call('POST', '', { slug: 'Bad Slug', name: 'x' })).status).toBe(422);
    const noIdentity = await call('POST', '', {
      slug: 'no-id',
      name: 'x',
      defaultIdentityId: 'nope',
    });
    expect(await noIdentity.json()).toMatchObject({ code: 'IDENTITY_NOT_FOUND' });
  });

  it('returns 404 for unknown orgs and does not touch other orgs on update', async () => {
    expect((await call('PATCH', '/missing', { name: 'x' })).status).toBe(404);
    const f = fixtures(appEnv);
    const a = await makeOrg(f);
    const b = await makeOrg(f);
    await call('PATCH', `/${a.id}`, { name: 'Renamed' });
    const rows = await all<{ id: string; name: string }>(
      env.DB,
      'SELECT id, name FROM orgs WHERE id = ?',
      [b.id],
    );
    expect(rows[0]?.name).toBe('Test Org');
  });

  it('counts only the org own rows and pages with a cursor', async () => {
    const f = fixtures(appEnv);
    const a = await makeOrg(f);
    const b = await makeOrg(f);
    const now = f.clock.now();
    for (const [org, n] of [
      [a.id, 2],
      [b.id, 1],
    ] as const) {
      for (let i = 0; i < n; i++)
        await run(
          env.DB,
          'INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [f.ids.id(), org, 'k', f.ids.id(), f.ids.id(), '[]', now],
        );
    }
    await run(
      env.DB,
      "INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, created_at, revoked_at) VALUES (?, ?, 'r', ?, ?, '[]', ?, ?)",
      [f.ids.id(), a.id, f.ids.id(), f.ids.id(), now, now],
    );
    const listed = (await (await call('GET', '?limit=1')).json()) as {
      items: { id: string }[];
      nextCursor: string | null;
    };
    expect(listed.items).toHaveLength(1);
    expect(listed.nextCursor).toBeTruthy();
    const all2 = (await (await call('GET', '?limit=200')).json()) as {
      items: { id: string; counts: { apiKeys: number } }[];
    };
    expect(all2.items.find((o) => o.id === a.id)?.counts.apiKeys).toBe(2);
    expect(all2.items.find((o) => o.id === b.id)?.counts.apiKeys).toBe(1);
    const page2 = (await (await call('GET', `?limit=200&cursor=${listed.nextCursor}`)).json()) as {
      items: { id: string }[];
    };
    expect(page2.items.map((o) => o.id)).not.toContain(listed.items[0]?.id);
  });
});

describe('isOrgActive', () => {
  it('is true only while the org is active', async () => {
    const f = fixtures(appEnv);
    const org = await makeOrg(f);
    const ctx = createServiceContext(appEnv);
    expect(await isOrgActive(ctx, org.id)).toBe(true);
    await call('PATCH', `/${org.id}`, { status: 'suspended' });
    expect(await isOrgActive(ctx, org.id)).toBe(false);
    await call('PATCH', `/${org.id}`, { status: 'active' });
    expect(await isOrgActive(ctx, org.id)).toBe(true);
    await call('DELETE', `/${org.id}`);
    expect(await isOrgActive(ctx, org.id)).toBe(false);
    expect(await isOrgActive(ctx, 'missing')).toBe(false);
  });
});
