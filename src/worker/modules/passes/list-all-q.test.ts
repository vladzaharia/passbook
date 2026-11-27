import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeApiKey, makeOrg, makePass } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { all, run } from '../../platform/db.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { listPassesSql } from './repo-list.ts';

let kit: Kit;
let app: OpenAPIHono<AppBindings>;
beforeAll(async () => {
  kit = await setupKit();
  app = createApp({
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(kit.env, kit.clock),
      apiKeys: createApiKeyStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
});

const list = (headers: Record<string, string>, query: string) =>
  app.request(`https://wallet.test/api/v1/passes?${query}`, { headers }, kit.env);

async function globalKey() {
  return (await makeApiKey(kit.fx, { orgId: null, scopes: ['passes:read'] })).headers;
}

describe('lists across organizations: repeated and foreign inputs', () => {
  it('gives each pass once when orgIds repeats an id', async () => {
    const org = await makeOrg(kit.fx);
    const pass = await makePass(kit.fx, { orgId: org.id, template: kit.template, persist: false });
    const res = await list(await globalKey(), `orgId=all&orgIds=${org.id},${org.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string }[] };
    expect(body.items.map((i) => i.id)).toEqual([pass.id]);
  });

  it('answers a q found only in a foreign org as it does a random q', async () => {
    const mine = await makeOrg(kit.fx);
    const theirs = await makeOrg(kit.fx);
    await makePass(kit.fx, { orgId: mine.id, template: kit.template, persist: false });
    const foreign = await makePass(kit.fx, {
      orgId: theirs.id,
      template: kit.template,
      persist: false,
      holderEmail: 'zholdq@example.com',
    });
    await run(
      kit.env.DB,
      "UPDATE passes SET display_title = 'Zorblaxq', external_id = 'zextq' WHERE id = ?",
      [foreign.id],
    );
    const key = await globalKey();
    for (const q of ['Zorblaxq', 'zextq', 'zholdq', foreign.serial]) {
      const hit = await list(key, `orgId=all&orgIds=${mine.id}&q=${encodeURIComponent(q)}`);
      const none = await list(key, `orgId=all&orgIds=${mine.id}&q=nothing-${kit.fx.ids.token(6)}`);
      expect(hit.status).toBe(none.status);
      expect(await hit.json()).toEqual(await none.json());
    }
    const own = await list(key, `orgId=all&orgIds=${theirs.id}&q=Zorblaxq`);
    expect(((await own.json()) as { items: unknown[] }).items).toHaveLength(1);
  });

  it('scopes every q lookup to the organization and mode', async () => {
    const { sql, params } = listPassesSql({ orgId: kit.org.id, mode: 'live', q: 'abc', limit: 50 });
    const plan = await all<{ detail: string }>(kit.env.DB, `EXPLAIN QUERY PLAN ${sql}`, params);
    const details = plan.map((p) => p.detail).join('\n');
    expect(details).toMatch(
      /passes_org_title \(org_id=\? AND mode=\? AND display_title>\? AND display_title<\?\)/,
    );
    expect(details).toMatch(/passes_org_subtitle \(org_id=\? AND mode=\?/);
    expect(details).not.toMatch(/passes_(title|subtitle|external|holder)_nc/);
  });
});
