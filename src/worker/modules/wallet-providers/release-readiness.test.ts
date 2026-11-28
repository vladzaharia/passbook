// TURN-0: the readiness report a flip is read against, and enable-ready (a dry run, or an apply once released).
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, makeSession } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { systemClock } from '../../platform/clock.ts';
import { all, first, run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { savePlatformCredential } from './credential-service.ts';
import { holdEnrolment, releaseEnrolment } from './enrolment-hold.ts';
import { disableEnrolment, enableEnrolment, setEnrolmentSource } from './enrolment-service.ts';
import { legacyOn, seedLegacyAccount } from './legacy-on-test-fixtures.ts';
import { setWalletReleaseForTest } from './provider-policy.ts';
import { addCheck } from './repo-wallet-credentials-test-fixtures.ts';
import { type Kit, kit } from './wallet-wa1b-test-fixtures.ts';

let k: Kit;
let app: ReturnType<typeof createApp>;
let source: { id: string; versionId: string };
let undo: (() => void) | null = null;
beforeAll(async () => {
  k = await kit();
  app = createApp({
    stores: {
      ...fakeAuth('https://wallet.test').stores,
      sessions: createSessionStore(k.env, systemClock),
    },
    clock: systemClock,
  });
  const admin = await k.admin('test');
  const saved = await savePlatformCredential(k.ctx, admin.auth, {
    mode: 'test',
    provider: 'google',
    expectedRevision: 0,
    credentials: k.google('777000444'),
  });
  const v = await first<{ v: string }>(
    env.DB,
    'SELECT current_version_id AS v FROM wallet_credentials WHERE id = ?',
    [saved.id],
  );
  source = { id: saved.id, versionId: v?.v ?? '' };
}, 30_000);
afterEach(() => {
  undo?.();
  undo = null;
});

async function headers(roles: ('admin' | 'user')[]) {
  const user = await k.admin('test');
  const s = await makeSession(k.f, { userId: user.user.id, roles });
  return { ...s.headers, 'x-passbook-mode': 'test' };
}
const call = async (h: Record<string, string>, method: string, path: string, body?: unknown) =>
  app.request(
    `https://wallet.test/api/v1/platform${path}`,
    {
      method,
      headers: { ...h, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    k.env,
  );

/** An org on the platform's Google Test credential: Off (source only), On, or a plan without Google. */
async function org(state: 'off' | 'on' | 'no_plan') {
  const o = await k.org();
  const m = await k.member(o.id, 'test');
  await setEnrolmentSource(k.ctx, m.auth, o.id, 'google', {
    source: 'platform',
    expectedRevision: 0,
  });
  if (state === 'on') {
    await addCheck(source.id, source.versionId);
    await enableEnrolment(k.ctx, m.auth, o.id, 'google', { expectedRevision: 1 });
  }
  if (state === 'no_plan')
    await run(
      env.DB,
      "INSERT INTO org_entitlement_overrides (org_id, key, value, updated_at) VALUES (?, 'wallet.google', '0', 1)",
      [o.id],
    );
  return o;
}

type Report = {
  releases: {
    provider: string;
    mode: string;
    state: string;
    credentials: { id: string }[];
    enrolments: { orgId: string; status: string; blocks: string[] }[];
    instances: { open: number; retired: number };
  }[];
};
const googleTest = (r: Report) =>
  r.releases.find((x) => x.provider === 'google' && x.mode === 'test');

describe('GET /platform/wallet-release', () => {
  it('lists every provider and mode, dark, with enrolments graded', async () => {
    const on = await org('on');
    const off = await org('off');
    const noPlan = await org('no_plan');
    const legacy = await k.org();
    const lm = await k.member(legacy.id, 'test');
    const configured = await seedLegacyAccount(k.ctx, lm.auth, {
      orgId: legacy.id,
      mode: 'test',
      provider: 'google',
      expectedRevision: 0,
      credentials: k.google('777000555'),
    });
    await addCheck(source.id, source.versionId);
    const res = await call(await headers(['admin', 'user']), 'GET', '/wallet-release');
    expect(res.status).toBe(200);
    const report = (await res.json()) as Report;
    expect(report.releases.map((r) => `${r.provider}:${r.mode}:${r.state}`)).toEqual([
      'google:test:dark',
      'google:live:dark',
      'samsung:test:dark',
      'samsung:live:dark',
    ]);
    const g = googleTest(report);
    expect(g?.credentials.map((c) => c.id)).toEqual([source.id]);
    const by = (id: string) => g?.enrolments.find((e) => e.orgId === id);
    expect(by(on.id)).toMatchObject({ status: 'issuing', blocks: [] });
    expect(by(off.id)).toMatchObject({ status: 'ready', blocks: [] });
    expect(by(noPlan.id)).toMatchObject({ status: 'blocked', blocks: ['plan'] });
    expect(by(legacy.id)).toMatchObject({ status: 'blocked', blocks: ['legacy'] });
    // A legacy envelope turned On by hand still reads as legacy: it never issues.
    await legacyOn(env.DB, configured.accountId);
    const again = (await (
      await call(await headers(['admin', 'user']), 'GET', '/wallet-release')
    ).json()) as Report;
    expect(googleTest(again)?.enrolments.find((e) => e.orgId === legacy.id)?.status).toBe(
      'blocked',
    );
    expect(g?.instances).toEqual({ open: 0, retired: 0 });
  });

  it('is for platform admins only', async () => {
    expect((await call(await headers(['user']), 'GET', '/wallet-release')).status).toBe(403);
  });
});

describe('POST /platform/wallet-release/{provider}/{mode}/enable-ready', () => {
  it('dry-runs the ready list, refuses an apply while dark, and applies it once released', async () => {
    const off = await org('off');
    await addCheck(source.id, source.versionId);
    const h = await headers(['admin', 'user']);
    const path = '/wallet-release/google/test/enable-ready';
    const dry = await call(h, 'POST', path, {});
    expect(dry.status).toBe(200);
    const listed = (await dry.json()) as { applied: boolean; enrolments: { orgId: string }[] };
    expect(listed.applied).toBe(false);
    expect(listed.enrolments.map((e) => e.orgId)).toContain(off.id);
    const enabled = async () =>
      (
        await first<{ at: number | null }>(
          env.DB,
          "SELECT enabled_at AS at FROM wallet_provider_accounts WHERE org_id = ? AND mode = 'test' AND provider = 'google'",
          [off.id],
        )
      )?.at ?? null;
    const orgIds = listed.enrolments.map((e) => e.orgId);
    // An apply names the reviewed list; a missing or different one is refused before anything is written.
    expect((await call(h, 'POST', path, { apply: true })).status).toBe(422);
    const stale = await call(h, 'POST', path, { apply: true, orgIds: orgIds.slice(1) });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { code: string }).code).toBe('WALLET_RELEASE_READY_CHANGED');
    const refused = await call(h, 'POST', path, { apply: true, orgIds });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe('WALLET_PROVIDER_DISABLED');
    expect(await enabled()).toBeNull();
    undo = setWalletReleaseForTest('released', { provider: 'google', mode: 'test' });
    const applied = await call(h, 'POST', path, { apply: true, orgIds });
    expect(applied.status).toBe(200);
    const result = (await applied.json()) as { applied: boolean; enrolments: { orgId: string }[] };
    expect(result.applied).toBe(true);
    expect(result.enrolments.map((e) => e.orgId)).toEqual(listed.enrolments.map((e) => e.orgId));
    expect(await enabled()).not.toBeNull();
    const audit = await all<{ actor_type: string; action: string }>(
      env.DB,
      "SELECT actor_type, action FROM audit_log WHERE org_id = ? AND action = 'wallet_provider.enrolment_enable'",
      [off.id],
    );
    expect(audit).toHaveLength(1);
    // Nothing is left to turn on.
    const after = (await (await call(h, 'POST', path, {})).json()) as { enrolments: unknown[] };
    expect(after.enrolments).toEqual([]);
  });

  it('leaves Off an enrolment the org switched Off or a released hold cleared', async () => {
    const switched = await org('on');
    const sm = await k.member(switched.id, 'test');
    await disableEnrolment(k.ctx, sm.auth, switched.id, 'google', { expectedRevision: 2 });
    const held = await org('on');
    const admin = await k.admin('test');
    const scope = { orgId: held.id, mode: 'test' as const, provider: 'google' as const };
    await holdEnrolment(k.ctx, admin.auth, scope, 'abuse');
    await releaseEnrolment(k.ctx, admin.auth, scope);
    await addCheck(source.id, source.versionId);
    const h = await headers(['admin', 'user']);
    const report = (await (await call(h, 'GET', '/wallet-release')).json()) as Report;
    const by = (id: string) => googleTest(report)?.enrolments.find((e) => e.orgId === id);
    expect(by(switched.id)).toMatchObject({ status: 'blocked', blocks: ['org_off'] });
    expect(by(held.id)).toMatchObject({ status: 'blocked', blocks: ['hold_released'] });
    const dry = (await (
      await call(h, 'POST', '/wallet-release/google/test/enable-ready', {})
    ).json()) as { enrolments: { orgId: string }[] };
    expect(dry.enrolments.map((e) => e.orgId)).not.toContain(switched.id);
    expect(dry.enrolments.map((e) => e.orgId)).not.toContain(held.id);
  });

  it('needs a recent sign-in', async () => {
    const user = await k.admin('test');
    const s = await makeSession(k.f, {
      userId: user.user.id,
      roles: ['admin', 'user'],
      authTime: Date.now() - 3_600_000,
    });
    const res = await call(
      { ...s.headers, 'x-passbook-mode': 'test' },
      'POST',
      '/wallet-release/google/test/enable-ready',
      {},
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('STEP_UP_REQUIRED');
  });
});
