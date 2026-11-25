import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { limitSuite, type Refused, setLimit } from '../../../../test/helpers/index.ts';
import { first } from '../../platform/db.ts';
import { type Api, BASE, setupApi } from './api-test-fixtures.ts';
import { stubNet } from './deliver-test-fixtures.ts';
import { clearResolverMemo } from './resolver-memo.ts';

let api: Api;
let net: ReturnType<typeof stubNet>;
let orgId: string;
let admin: Record<string, string>;
let n = 0;

beforeAll(async () => {
  api = await setupApi();
  net = stubNet();
  clearResolverMemo();
  orgId = await api.otherOrg();
  admin = await api.member(['org_admin'], { orgId });
});
afterAll(() => net.restore());

const create = async (): Promise<Refused | null> => {
  const res = await api.call(
    'POST',
    BASE,
    { orgId, url: `https://hooks.example.com/${++n}`, eventTypes: ['pass.issued'] },
    admin,
  );
  return res.status < 300 ? null : { ...res.json, status: res.status };
};

const held = async () =>
  (
    await first<{ n: number }>(
      api.rig.db,
      'SELECT COUNT(*) AS n FROM webhook_endpoints WHERE org_id = ?',
      [orgId],
    )
  )?.n ?? 0;

limitSuite('webhook endpoints', async () => ({
  db: api.rig.db,
  orgId,
  key: 'webhooks.endpoints',
  create,
  count: held,
}));

describe('webhook endpoint limits', () => {
  it('the cap counts both modes of the org, and a deleted endpoint frees its slot', async () => {
    const before = await held();
    await setLimit(api.rig.db, orgId, 'webhooks.endpoints', before + 1);
    expect(await create()).toBeNull();
    expect(await create()).toMatchObject({ code: 'FEATURE_LIMIT_REACHED' });
    const { json } = await api.call('GET', `${BASE}?orgId=${orgId}`, undefined, admin);
    const id = json.items[0].id as string;
    expect((await api.call('DELETE', `${BASE}/${id}`, undefined, admin)).status).toBeLessThan(300);
    expect(await create()).toBeNull();
  });

  it('an org above its limit keeps its endpoints and refuses new ones', async () => {
    const before = await held();
    await setLimit(api.rig.db, orgId, 'webhooks.endpoints', 0);
    expect(await held()).toBe(before);
    expect(await create()).toMatchObject({ code: 'FEATURE_LIMIT_REACHED', limit: 0, used: before });
  });
});

describe('webhook endpoints need the webhooks feature', () => {
  it('refuses a create when the plan lacks webhooks, with FEATURE_NOT_INCLUDED', async () => {
    const trial = await api.otherOrg();
    await setLimit(api.rig.db, trial, 'webhooks', 0);
    const who = await api.member(['org_admin'], { orgId: trial });
    const res = await api.call(
      'POST',
      BASE,
      { orgId: trial, url: 'https://hooks.example.com/t', eventTypes: ['pass.issued'] },
      who,
    );
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ code: 'FEATURE_NOT_INCLUDED' });
  });
});
