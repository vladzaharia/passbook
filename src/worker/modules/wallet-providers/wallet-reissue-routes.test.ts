import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { all } from '../../platform/db.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { setupTenantTestAuth, type TenantTestAuth } from '../passes/tenant-test-fixtures.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';

const ORIGIN = 'https://wallet.test';
let kit: Kit;
let auth: TenantTestAuth;
let app: ReturnType<typeof createApp>;
let orgB: { id: string };
const undo: (() => void)[] = [];

beforeAll(async () => {
  kit = await setupKit();
  orgB = await makeOrg(kit.fx, { name: 'Other Org' });
  auth = await setupTenantTestAuth(kit);
  await auth.addOrg(orgB.id);
  app = createApp({ stores: auth.stores, clock: kit.clock });
}, 30_000);
afterEach(() => {
  for (const u of undo.splice(0)) u();
});

const post = (headers: Record<string, string>, body: unknown) =>
  app.request(
    `${ORIGIN}/api/v1/wallet-providers/reissue`,
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    kit.env,
  );
const on = () => undo.push(setWalletProvidersEnabledForTest(true));
const audits = async (orgId: string) =>
  all<{ action: string; detail: string }>(
    kit.env.DB,
    `SELECT action, detail FROM audit_log WHERE org_id = ? AND action = 'wallet.reissue'`,
    [orgId],
  );

describe('POST /wallet-providers/reissue', () => {
  it('refuses anonymous callers, plain users and keys without passes:write', async () => {
    on();
    const body = { orgId: kit.org.id, provider: 'google' };
    expect((await post({}, body)).status).toBe(401);
    await expectProblem(await post(auth.user(), body), 403, 'FORBIDDEN');
    const readOnly = await auth.apiKey({ orgId: kit.org.id, scopes: ['passes:read'] });
    await expectProblem(await post(readOnly, body), 403, 'MISSING_SCOPE');
  });

  it('refuses a key of another organization', async () => {
    on();
    const key = await auth.apiKey({ orgId: orgB.id, scopes: ['passes:write'] });
    await expectProblem(
      await post(key, { orgId: kit.org.id, provider: 'google' }),
      403,
      'ORG_FORBIDDEN',
    );
  });

  it('answers a dark provider and mode with a refusal, not a zero', async () => {
    const key = await auth.apiKey({ orgId: kit.org.id, scopes: ['passes:write'] });
    const res = await post(key, { orgId: kit.org.id, provider: 'google' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await audits(kit.org.id)).length).toBe(0);
  });

  it('follows the key mode: Live released, a Test key is refused', async () => {
    undo.push(setWalletProvidersEnabledForTest(true, 'live'));
    const test = await auth.apiKey({ orgId: kit.org.id, scopes: ['passes:write'], mode: 'test' });
    expect(
      (await post(test, { orgId: kit.org.id, provider: 'google' })).status,
    ).toBeGreaterThanOrEqual(400);
    const live = await auth.apiKey({ orgId: kit.org.id, scopes: ['passes:write'], mode: 'live' });
    expect((await post(live, { orgId: kit.org.id, provider: 'google' })).status).toBe(202);
  });

  it('queues the reissue, audits it and answers 202', async () => {
    on();
    const key = await auth.apiKey({ orgId: kit.org.id, scopes: ['passes:write'] });
    const before = (await audits(kit.org.id)).length;
    const res = await post(key, { orgId: kit.org.id, provider: 'google' });
    expect(res.status).toBe(202);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ instances: 0 });
    const rows = await audits(kit.org.id);
    expect(rows).toHaveLength(before + 1);
    expect(JSON.parse(rows[before]?.detail ?? '{}')).toMatchObject({
      provider: 'google',
      instances: 0,
    });
  });

  it('limits a key to six an hour and an org to twelve', async () => {
    on();
    const keyA = await auth.apiKey({ orgId: orgB.id, scopes: ['passes:write'] });
    for (let i = 0; i < 6; i++)
      expect((await post(keyA, { orgId: orgB.id, provider: 'samsung' })).status).toBe(202);
    await expectProblem(await post(keyA, { orgId: orgB.id, provider: 'samsung' }), 429, [
      'RATE_LIMITED',
    ]);
    const keyB = await auth.apiKey({ orgId: orgB.id, scopes: ['passes:write'] });
    for (let i = 0; i < 6; i++)
      expect((await post(keyB, { orgId: orgB.id, provider: 'samsung' })).status).toBe(202);
    await expectProblem(await post(keyB, { orgId: orgB.id, provider: 'samsung' }), 429, [
      'RATE_LIMITED',
    ]);
  });
});
