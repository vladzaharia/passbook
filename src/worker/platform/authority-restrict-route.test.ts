// The route gate for a key limited to templates: refused anywhere that does not enforce the limit, admitted where
// the route says it does, and then held to its templates by the builder's reads and grants.

import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { makeApiKey } from '../../../test/helpers/index.ts';
import { authOf } from '../modules/passes/http.ts';
import { createAuthStores } from '../stores.ts';
import { requireCaller } from './auth.ts';
import { grant } from './authority.ts';
import { db } from './authority-ext-fixtures.ts';
import { authorityPredicate } from './authority-read.ts';
import { world } from './authority-restrict-fixtures.ts';
import { type AppBindings, requestContext } from './context.ts';
import { all } from './db.ts';
import { handleError } from './error-handler.ts';
import { legacyTenantSessionOrApiKey } from './route-auth-legacy.ts';

async function setup(label: string) {
  const w = await world(label);
  const { f } = w.x.s;
  const app = new Hono<AppBindings>();
  app.use('*', requestContext({ stores: (e) => createAuthStores(e, f.clock), clock: f.clock }));
  app.onError((error, c) => handleError(error, c) as Response);
  // A route that enforces the limit: a read through the shared read predicate, a write through a grant.
  app.get('/scoped', requireCaller({ scope: 'passes:read', templateScoped: true }), async (c) => {
    const auth = authOf(c);
    if (auth.kind !== 'api_key') throw new Error('key expected');
    const principal = w.principal(auth.keyId, 'passes:read');
    const p = authorityPredicate(principal, { scope: 'org_mode', now: f.clock.now() });
    const rows = await all<{ id: string }>(
      db,
      `WITH ${p.ctes} SELECT p.id FROM ${p.rows}passes p WHERE ${p.tenant('p', 'passes')} ORDER BY p.id`,
      p.params,
    );
    return c.json({ ids: rows.map((r) => r.id), limited: auth.limited === true });
  });
  app.post('/scoped', requireCaller({ scope: 'passes:write', templateScoped: true }), async (c) => {
    const auth = authOf(c);
    if (auth.kind !== 'api_key') throw new Error('key expected');
    const { id } = (await c.req.json()) as { id: string };
    const g = grant(w.x.route, {
      purpose: 'org_mode.pass.publish',
      principal: w.principal(auth.keyId),
    });
    g.update('passes', { set: { display_title: 'routed' }, where: { id }, returning: ['id'] });
    const [result] = await g.commit();
    return c.json({ changed: result?.results.length ?? 0 });
  });
  app.get('/plain', requireCaller({ scope: 'passes:read' }), (c) => c.json({ ok: true }));
  app.get('/legacy', legacyTenantSessionOrApiKey(['passes:read']), (c) => c.json({ ok: true }));
  const call = async (
    path: string,
    key: { headers: Record<string, string> },
    init: RequestInit = {},
  ) => {
    const res = await app.request(
      `https://wallet.test${path}`,
      { ...init, headers: { ...key.headers, 'content-type': 'application/json' } },
      env,
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const limited = async (limit: { templateIds?: string[]; passStyles?: string[] }) =>
    makeApiKey(f, {
      orgId: w.org.id,
      scopes: ['passes:read', 'passes:write'],
      ...limit,
    });
  return { w, call, limited };
}

describe('a key limited to templates at the route', () => {
  it('is refused on a route that does not enforce the limit, however it is guarded', async () => {
    const { w, call, limited } = await setup('rt-gate');
    const key = await limited({ templateIds: [w.a.id] });
    for (const path of ['/plain', '/legacy']) {
      const res = await call(path, key);
      expect({ path, status: res.status, code: res.body.code }).toEqual({
        path,
        status: 403,
        code: 'API_KEY_RESTRICTED_ROUTE',
      });
    }
  });

  it('sees only its templates on a route that enforces the limit; the same route shows an unlimited key the org', async () => {
    const { w, call, limited } = await setup('rt-read');
    const own = await call('/scoped', await limited({ templateIds: [w.a.id] }));
    expect(own).toMatchObject({ status: 200, body: { limited: true } });
    expect((own.body.ids as string[]).sort()).toEqual([w.a.pass]);
    const styled = await call('/scoped', await limited({ passStyles: ['coupon'] }));
    expect((styled.body.ids as string[]).sort()).toEqual([w.a.pass]);
    const free = await call('/scoped', await makeApiKey(w.x.s.f, { orgId: w.org.id }));
    expect(free.body.limited).toBe(false);
    expect((free.body.ids as string[]).length).toBeGreaterThanOrEqual(3);
  });

  it("changes a pass of its template and cannot touch another template's", async () => {
    const { w, call, limited } = await setup('rt-write');
    const key = await limited({ templateIds: [w.a.id] });
    const post = (id: string) =>
      call('/scoped', key, { method: 'POST', body: JSON.stringify({ id }) });
    expect((await post(w.a.pass)).body).toEqual({ changed: 1 });
    expect((await post(w.b.pass)).body).toEqual({ changed: 0 });
  });

  it('a limit is checked when the key is used: a revoked or expired limited key is refused as any key', async () => {
    const { w, call, limited } = await setup('rt-dead');
    const key = await limited({ templateIds: [w.a.id] });
    await db.prepare('UPDATE api_keys SET revoked_at = 1 WHERE id = ?').bind(key.id).run();
    expect((await call('/scoped', key)).status).toBe(401);
  });

  it('a personal key is limited the same way, and still capped by its member', async () => {
    const { w, call } = await setup('rt-personal');
    const { f } = w.x.s;
    const key = await makeApiKey(f, {
      orgId: w.org.id,
      kind: 'personal',
      membershipId: w.x.s.membershipId,
      expiresAt: f.clock.now() + 86_400_000,
      scopes: ['passes:read'],
      templateIds: [w.a.id],
    });
    const res = await call('/scoped', key);
    expect((res.body.ids as string[]).sort()).toEqual([w.a.pass]);
    // The member loses the membership: the key goes with it, limited or not.
    await db
      .prepare('UPDATE org_memberships SET revoked_at = 1 WHERE id = ?')
      .bind(w.x.s.membershipId)
      .run();
    expect((await call('/scoped', key)).body.ids ?? []).toEqual([]);
  });
});
