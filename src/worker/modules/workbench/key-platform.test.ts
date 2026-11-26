import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeApiKey } from '../../../../test/helpers/index.ts';
import { first } from '../../platform/db.ts';
import { bearer, workbenchKit } from './workbench-test-fixtures.ts';

let t: Awaited<ReturnType<typeof workbenchKit>>;
beforeAll(async () => {
  t = await workbenchKit();
});
afterAll(() => vi.unstubAllGlobals());

const day = 86_400_000;
const platformKeys = () =>
  first<{ n: number }>(t.kit.env.DB, `SELECT COUNT(*) AS n FROM api_keys WHERE org_id IS NULL`);

describe('a Platform key and a Workbench token never stand in for each other', () => {
  it('a token mints no Platform key, with or without platform scopes', async () => {
    const m = await t.member();
    const { token } = await t.wbMint(m.browser, m.orgId);
    const before = await platformKeys();
    const expiresAt = t.kit.clock.now() + 7 * day;
    for (const body of [
      { orgId: null, kind: 'platform', scopes: ['platform:read'] },
      { orgId: null, kind: 'platform', scopes: ['passes:read'] },
      { orgId: m.orgId, kind: 'platform', scopes: ['platform:read'] },
    ]) {
      const res = await t.call('POST', '/api-keys', t.asClient(token), {
        name: 'Escalate',
        expiresAt,
        ...body,
      });
      expect(res.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    expect(await platformKeys()).toEqual(before);
  });

  it('a Platform key is no Workbench token: it cannot mint one or act under the token rules', async () => {
    const m = await t.member();
    const key = await makeApiKey(t.kit.f, {
      kind: 'platform',
      orgId: null,
      scopes: ['platform:read'],
    });
    const res = await t.call('POST', '/workbench/token', bearer(key.token), { orgId: m.orgId });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    // It gets no token's Test pin or org either: a key of no org reaches no org's rows.
    const read = await t.call('GET', `/orgs/${m.orgId}/members`, bearer(key.token));
    expect(read.status).toBeGreaterThanOrEqual(400);
    expect(read.status).toBeLessThan(500);
  });
});
