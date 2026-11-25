import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockWallets } from '../../../../test/mock-wallets/index.ts';
import { createFixtureIdentity } from '../../../passkit/testing/fixture-identity.ts';
import { runJob } from '../../jobs/registry.ts';
import type { Job } from '../../jobs/types.ts';
import { grant } from '../../platform/authority.ts';
import { ManualClock } from '../../platform/clock.ts';
import { credentialAad, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { all, first } from '../../platform/db.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { dailyCheckId, enqueueCredentialChecks, runCredentialCheck } from './account-check.ts';
import { readCredentialCheck, requestCredentialCheck } from './account-check-request.ts';
import { credentialIdentityHash } from './account-credential-source.ts';
import {
  revokePlatformCredential,
  saveOrgCredential,
  savePlatformCredential,
} from './credential-service.ts';
import { findActiveCredential, saveCredential } from './repo-credentials.ts';
import { CHECK_JOB, granted, ident, uid } from './repo-wallet-credentials-test-fixtures.ts';
import { samsungCredentialWindow } from './samsung-credentials.ts';
import { type Kit, kit } from './wallet-wa1b-test-fixtures.ts';

const DAY = 86_400_000;
let k: Kit;
let mock: ReturnType<typeof createMockWallets>;
let longIdentity: Awaited<ReturnType<typeof createFixtureIdentity>>;
beforeAll(async () => {
  k = await kit();
  longIdentity = await createFixtureIdentity(undefined, { days: 90, caDays: 90 });
}, 30_000);

function stubProviders() {
  mock = createMockWallets();
  // Builds the Request from the client's exact init: workerd throws on redirect 'error'.
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    mock.handle(new Request(input, init)),
  );
}
afterEach(() => vi.unstubAllGlobals());

/** The kit's certificate lives 2 days, which is already inside the 30-day warning. */
const longSamsung = (cardId = 'card123') => ({
  ...k.samsung(cardId),
  partnerPrivateKeyPem: longIdentity.privateKey,
  partnerCertificatePem: longIdentity.certificate,
  samsungCertificatePem: longIdentity.certificate,
});

const jobCtx = (clock?: ManualClock) =>
  createJobContext(k.env, 'wallet.credential_check', clock ? { clock } : {});

/** One active platform credential per mode and provider: revoke the last test's. */
async function freeSlot(
  admin: Awaited<ReturnType<Kit['admin']>>,
  mode: 'live' | 'test',
  provider: 'google' | 'samsung',
) {
  const active = await findActiveCredential(env.DB, null, mode, provider);
  if (active)
    await revokePlatformCredential(k.ctx, admin.auth, active.id, {
      expectedRevision: active.revision,
    });
}

async function platformCred(
  provider: 'google' | 'samsung',
  mode: 'live' | 'test',
  creds?: unknown,
) {
  const admin = await k.admin();
  await freeSlot(admin, mode, provider);
  const credentials = creds ?? (provider === 'google' ? k.google() : k.samsung());
  const saved = await savePlatformCredential(k.ctx, admin.auth, {
    provider,
    mode,
    expectedRevision: 0,
    credentials,
  } as never);
  return { admin, id: saved.id };
}

const checkOf = (credentialId: string, checkId: string) =>
  first<{ ok: number; code: string | null; version_id: string }>(
    env.DB,
    'SELECT ok, code, version_id FROM wallet_credential_checks WHERE credential_id = ? AND id = ?',
    [credentialId, checkId],
  );

async function check(credentialId: string, ctx = jobCtx()) {
  const checkId = uid();
  await runCredentialCheck(ctx, { credentialId, checkId });
  return checkOf(credentialId, checkId);
}

describe('google check', () => {
  it('passes with an OAuth token and the issuer read, on the current version', async () => {
    stubProviders();
    const { id } = await platformCred('google', 'test');
    const row = await check(id);
    expect(row).toMatchObject({ ok: 1, code: null });
    const current = await first<{ current_version_id: string }>(
      env.DB,
      'SELECT current_version_id FROM wallet_credentials WHERE id = ?',
      [id],
    );
    expect(row?.version_id).toBe(current?.current_version_id);
    expect(mock.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /token',
      'GET /walletobjects/v1/issuer/123456789',
    ]);
  });

  it('records an authentication failure', async () => {
    stubProviders();
    mock.failNext({ status: 401, match: 'POST /token' });
    const { id } = await platformCred('google', 'live');
    expect(await check(id)).toMatchObject({ ok: 0, code: 'auth_failed' });
  });

  it('records a wrong issuer', async () => {
    stubProviders();
    mock.failNext({ status: 404, match: 'GET /walletobjects/v1/issuer/' });
    const { id } = await platformCred('google', 'test');
    expect(await check(id)).toMatchObject({ ok: 0, code: 'issuer_not_found' });
  });

  it('records an unreachable provider', async () => {
    stubProviders();
    mock.failNext({ status: 503, match: 'POST /token' });
    const { id } = await platformCred('google', 'live');
    expect(await check(id)).toMatchObject({ ok: 0, code: 'unreachable' });
  });

  it('rechecks within 15 minutes after a transient failure, and never after a definitive one (Q6)', async () => {
    stubProviders();
    const sent: { body: unknown; options: unknown }[] = [];
    const withJobs = () => {
      const base = jobCtx();
      return {
        ...base,
        env: {
          ...base.env,
          JOBS: {
            send: async (body: unknown, options: unknown) => void sent.push({ body, options }),
          },
        },
      } as unknown as typeof base;
    };
    mock.failNext({ status: 503, match: 'POST /token' });
    const transient = await platformCred('google', 'live');
    await runCredentialCheck(withJobs(), { credentialId: transient.id, checkId: uid() });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({
      kind: 'wallet.credential_check',
      credentialId: transient.id,
    });
    expect(sent[0]?.options).toEqual({ delaySeconds: 600 });
    mock.failNext({ status: 401, match: 'POST /token' });
    const definitive = await platformCred('google', 'live');
    await runCredentialCheck(withJobs(), { credentialId: definitive.id, checkId: uid() });
    expect(sent).toHaveLength(1);
  });

  it('fails a secret whose identity is not the stored identity_hash', async () => {
    stubProviders();
    const admin = await k.admin();
    await freeSlot(admin, 'test', 'google');
    const versionId = uid();
    const credentialId = uid();
    const credentials = k.google();
    const kind = `wallet-credential:${credentialId}:platform:test:google`;
    const envelope = await encryptSecret(
      await loadKekRing(k.env),
      JSON.stringify({ version: 1, provider: 'google', credentials }),
      credentialAad(versionId, null, kind),
    );
    // The rows claim another issuer than the secret carries.
    expect(await credentialIdentityHash({ provider: 'google', credentials })).not.toBe(ident());
    await saveCredential(
      k.ctx,
      {
        purpose: 'platform.wallet.credential_save',
        principal: {
          kind: 'platform',
          userId: admin.user.id,
          sessionIdHash: admin.auth.kind === 'session' ? admin.auth.sessionId : '',
        },
        checks: [],
        actor: { type: 'platform', id: admin.user.id },
        platform: true,
      },
      {
        credentialId,
        expectedRevision: 0,
        mode: 'test',
        provider: 'google',
        identityHash: ident(),
        identityHint: '0000',
        versionId,
        eventId: uid(),
        cardMap: {},
        envelope,
      },
    );
    expect(await check(credentialId)).toMatchObject({ ok: 0, code: 'credential_unreadable' });
    expect(mock.requests).toHaveLength(0);
  });
});

describe('redirects', () => {
  it('are never followed or accepted: a 3xx is a provider error', async () => {
    stubProviders();
    const calls: (string | undefined)[] = [];
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init?.redirect);
      if (String(input).endsWith('/token'))
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }),
        );
      return inner(input, init);
    });
    const { id } = await platformCred('google', 'test');
    expect(await check(id)).toMatchObject({ ok: 0, code: 'provider_error' });
    expect(calls).toEqual(['manual']);
  });

  it('a 3xx from the issuer read or from Samsung is a provider error', async () => {
    stubProviders();
    const redirect = (match: RegExp) => {
      const inner = globalThis.fetch;
      vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
        match.test(String(input))
          ? Promise.resolve(
              new Response(null, { status: 307, headers: { location: 'https://evil.test/' } }),
            )
          : inner(input, init),
      );
    };
    redirect(/\/issuer\//);
    const google = await platformCred('google', 'test');
    expect(await check(google.id)).toMatchObject({ ok: 0, code: 'provider_error' });
    redirect(/card\/template/);
    const samsung = await platformCred('samsung', 'test', longSamsung());
    expect(await check(samsung.id)).toMatchObject({ ok: 0, code: 'provider_error' });
  });
});

describe('samsung check', () => {
  it('reads the template of the credential card', async () => {
    stubProviders();
    const { id } = await platformCred('samsung', 'test', longSamsung());
    expect(await check(id)).toMatchObject({ ok: 1, code: null });
    expect(mock.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /partner/v1/card/template/card123',
    ]);
  });

  it('probes every card of the map and refuses a typed card of another type', async () => {
    stubProviders();
    const creds = { ...longSamsung('card321'), cardIds: { ticket: 'cardT1' } };
    mock.setSamsungTemplate('cardT1', {
      cardType: 'ticket',
      subType: 'others',
      countryCode: 'US',
      state: 'ACTIVE',
      testingModeOff: 'Y',
    });
    const ok = await platformCred('samsung', 'test', creds);
    expect(await check(ok.id)).toMatchObject({ ok: 1, code: null });
    expect(mock.requests.map((r) => r.path).sort()).toEqual([
      '/partner/v1/card/template/card321',
      '/partner/v1/card/template/cardT1',
    ]);
    mock.setSamsungTemplate('cardT2', {
      cardType: 'coupon',
      subType: 'others',
      countryCode: 'US',
      state: 'ACTIVE',
      testingModeOff: 'Y',
    });
    const wrong = await platformCred('samsung', 'live', {
      ...longSamsung('card322'),
      cardIds: { ticket: 'cardT2' },
    });
    expect(await check(wrong.id)).toMatchObject({ ok: 0, code: 'card_not_found' });
  });

  it('refuses a card that is not active on Live and one Samsung does not know', async () => {
    stubProviders();
    mock.setSamsungTemplate('card123', {
      cardType: 'ticket',
      subType: 'others',
      countryCode: 'US',
      state: 'ACTIVE',
      testingModeOff: 'N',
    });
    const live = await platformCred('samsung', 'live', longSamsung());
    expect(await check(live.id)).toMatchObject({ ok: 0, code: 'card_not_active' });
    mock.failNext({ status: 404, match: 'GET /partner/v1/card/template/' });
    const test = await platformCred('samsung', 'test', longSamsung('card456'));
    expect(await check(test.id)).toMatchObject({ ok: 0, code: 'card_not_found' });
  });

  it('warns 30 days before the certificate expires and fails at expiry', async () => {
    stubProviders();
    const creds = longSamsung('card789');
    const { validUntil } = await samsungCredentialWindow(creds);
    const { id } = await platformCred('samsung', 'test', creds);
    expect(await check(id, jobCtx(new ManualClock(validUntil - 31 * DAY)))).toMatchObject({
      ok: 1,
      code: null,
    });
    expect(await check(id, jobCtx(new ManualClock(validUntil - 30 * DAY)))).toMatchObject({
      ok: 1,
      code: 'cert_expiring',
    });
    const calls = mock.requests.length;
    expect(await check(id, jobCtx(new ManualClock(validUntil)))).toMatchObject({
      ok: 0,
      code: 'cert_expired',
    });
    expect(mock.requests).toHaveLength(calls);
  });
});

describe('who writes a check', () => {
  it('only the check job grant, as a system principal, can insert one', async () => {
    const { id } = await platformCred('google', 'test');
    const version = await first<{ v: string }>(
      env.DB,
      'SELECT current_version_id AS v FROM wallet_credentials WHERE id = ?',
      [id],
    );
    const insert = () =>
      env.DB.prepare(
        'INSERT INTO wallet_credential_checks (id, credential_id, version_id, ok) VALUES (?, ?, ?, 1)',
      ).bind(uid(), id, version?.v);
    await expect(insert().run()).rejects.toThrow(/check job/);
    await expect(
      granted({ purpose: CHECK_JOB.purpose, principal: 'platform:u1' }, [insert()]),
    ).rejects.toThrow();
    // A request grant of the platform writes credentials, not checks.
    expect(() => {
      const g = grant(k.ctx, {
        purpose: 'platform.wallet.credential_save',
        principal: { kind: 'platform', userId: 'u1', sessionIdHash: 'x' },
        tables: ['wallet_credential_checks'],
      });
      g.insertJoined('wallet_credential_checks', {
        parents: { credential_id: id },
        columns: ['id', 'version_id', 'ok'],
        values: [uid(), version?.v ?? '', 1],
      });
    }).toThrow();
    await granted(CHECK_JOB, [insert()]);
  });
});

describe('verify', () => {
  it('stamps verified_at on an org credential once, under one verify event', async () => {
    stubProviders();
    const org = await k.org();
    const { auth } = await k.member(org.id);
    const saved = await saveOrgCredential(k.ctx, auth, org.id, {
      provider: 'google',
      expectedRevision: 0,
      credentials: k.google('987654321'),
    });
    expect(saved.verifiedAt).toBeNull();
    expect(await check(saved.id)).toMatchObject({ ok: 1 });
    const after = await first<{ verified_at: number; revision: number }>(
      env.DB,
      'SELECT verified_at, revision FROM wallet_credentials WHERE id = ?',
      [saved.id],
    );
    expect(after?.verified_at).toBeGreaterThan(0);
    expect(after?.revision).toBe(2);
    expect(await check(saved.id)).toMatchObject({ ok: 1 });
    expect(
      await first(env.DB, 'SELECT verified_at, revision FROM wallet_credentials WHERE id = ?', [
        saved.id,
      ]),
    ).toEqual(after);
    expect(
      await all(
        env.DB,
        "SELECT actor_type FROM wallet_credential_events WHERE credential_id = ? AND kind = 'verify'",
        [saved.id],
      ),
    ).toEqual([{ actor_type: 'system' }]);
    expect(
      await first(
        env.DB,
        "SELECT action FROM audit_log WHERE target_id = ? AND action = 'wallet_provider.credential_verify'",
        [saved.id],
      ),
    ).not.toBeNull();
  });

  it('a failed check verifies nothing and a platform credential is never stamped', async () => {
    stubProviders();
    mock.failNext({ status: 401, match: 'POST /token' });
    const org = await k.org();
    const { auth } = await k.member(org.id);
    const saved = await saveOrgCredential(k.ctx, auth, org.id, {
      provider: 'google',
      expectedRevision: 0,
      credentials: k.google('555000111'),
    });
    expect(await check(saved.id)).toMatchObject({ ok: 0 });
    const row = () =>
      first<{ verified_at: number | null }>(
        env.DB,
        'SELECT verified_at FROM wallet_credentials WHERE id = ?',
        [saved.id],
      );
    expect(await row()).toEqual({ verified_at: null });
    const platform = await platformCred('google', 'live', k.google('424242424'));
    expect(await check(platform.id)).toMatchObject({ ok: 1 });
    expect(
      await first(env.DB, 'SELECT verified_at FROM wallet_credentials WHERE id = ?', [platform.id]),
    ).toEqual({ verified_at: null });
  });
});

describe('check request', () => {
  it('queues a job and returns the handle its result reads under; an org cannot check another org', async () => {
    stubProviders();
    const a = await k.org();
    const b = await k.org();
    const ma = await k.member(a.id);
    const mb = await k.member(b.id);
    const saved = await saveOrgCredential(k.ctx, ma.auth, a.id, {
      provider: 'google',
      expectedRevision: 0,
      credentials: k.google('111222333'),
    });
    const sent: unknown[] = [];
    const ctx = {
      ...k.ctx,
      env: { ...k.env, JOBS: { send: async (j: unknown) => void sent.push(j) } },
    } as unknown as typeof k.ctx;
    const queued = await requestCredentialCheck(ctx, ma.auth, { orgId: a.id }, saved.id);
    expect(queued.status).toBe('queued');
    expect(sent).toEqual([
      { kind: 'wallet.credential_check', credentialId: saved.id, checkId: queued.checkId },
    ]);
    expect(
      await readCredentialCheck(ctx, ma.auth, { orgId: a.id }, saved.id, queued.checkId),
    ).toMatchObject({ status: 'pending' });
    await runJob(sent[0] as Job, jobCtx());
    expect(
      await readCredentialCheck(ctx, ma.auth, { orgId: a.id }, saved.id, queued.checkId),
    ).toMatchObject({ status: 'ok', code: null });
    // B's member names A's credential under B, and under A.
    await expect(
      requestCredentialCheck(ctx, mb.auth, { orgId: b.id }, saved.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      requestCredentialCheck(ctx, mb.auth, { orgId: a.id }, saved.id),
    ).rejects.toMatchObject({ status: 403 });
    // A platform credential is not an org's to check, and a user is not a platform admin.
    const platform = await platformCred('google', 'test', k.google('777888999'));
    await expect(
      requestCredentialCheck(ctx, ma.auth, { orgId: a.id }, platform.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      requestCredentialCheck(ctx, ma.auth, { orgId: null }, platform.id),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      (await requestCredentialCheck(ctx, platform.admin.auth, { orgId: null }, platform.id)).status,
    ).toBe('queued');
    expect(sent).toHaveLength(2);
  });
});

describe('check rate limit', () => {
  it('allows 10 requests per credential per hour, then 429', async () => {
    const platform = await platformCred('google', 'live', k.google('314159265'));
    const sent: unknown[] = [];
    const ctx = {
      ...k.ctx,
      env: { ...k.env, JOBS: { send: async (j: unknown) => void sent.push(j) } },
    } as unknown as typeof k.ctx;
    for (let i = 0; i < 10; i++)
      await requestCredentialCheck(ctx, platform.admin.auth, { orgId: null }, platform.id);
    await expect(
      requestCredentialCheck(ctx, platform.admin.auth, { orgId: null }, platform.id),
    ).rejects.toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    expect(sent).toHaveLength(10);
  });
});

describe('daily cron', () => {
  const batcher = (sent: Job[]) =>
    ({
      ...jobCtx(),
      env: {
        ...k.env,
        JOBS: {
          sendBatch: async (m: { body: Job }[]) => void sent.push(...m.map((x) => x.body)),
          send: async (j: Job) => void sent.push(j),
        },
      },
    }) as unknown as ReturnType<typeof jobCtx>;
  const versionOf = async (id: string) =>
    (
      await first<{ v: string }>(
        env.DB,
        'SELECT current_version_id AS v FROM wallet_credentials WHERE id = ?',
        [id],
      )
    )?.v ?? '';

  it('queues one job per active credential and a rerun adds no check', async () => {
    stubProviders();
    const live = await platformCred('google', 'live', k.google('135791357'));
    const revoked = await platformCred('samsung', 'live', longSamsung());
    await revokePlatformCredential(k.ctx, revoked.admin.auth, revoked.id, { expectedRevision: 1 });
    const sent: Job[] = [];
    const ctx = batcher(sent);
    await enqueueCredentialChecks(ctx);
    await enqueueCredentialChecks(ctx);
    const mine = sent.filter(
      (j) => j.kind === 'wallet.credential_check' && j.credentialId === live.id,
    );
    expect(mine).toHaveLength(2);
    expect(mine[0]).toEqual(mine[1]);
    expect(mine[0]).toMatchObject({
      checkId: dailyCheckId(live.id, await versionOf(live.id), ctx.clock.now()),
    });
    expect(
      sent.some((j) => j.kind === 'wallet.credential_check' && j.credentialId === revoked.id),
    ).toBe(false);
    for (const job of mine) await runJob(job, jobCtx());
    expect(
      (
        await first<{ n: number }>(
          env.DB,
          'SELECT count(*) AS n FROM wallet_credential_checks WHERE credential_id = ?',
          [live.id],
        )
      )?.n,
    ).toBe(1);
  });

  it('pages past one page and batches within the queue limit', async () => {
    const org = await k.org();
    const { auth } = await k.member(org.id);
    await saveOrgCredential(k.ctx, auth, org.id, {
      provider: 'google',
      expectedRevision: 0,
      credentials: k.google('808080808'),
    });
    const sizes: number[] = [];
    const ctx = {
      ...jobCtx(),
      env: { ...k.env, JOBS: { sendBatch: async (m: unknown[]) => void sizes.push(m.length) } },
    } as unknown as ReturnType<typeof jobCtx>;
    await enqueueCredentialChecks(ctx);
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100);
  });

  it('a rotation queues the new version, and the next daily run adds another check', async () => {
    stubProviders();
    const org = await k.org();
    const { auth } = await k.member(org.id);
    const sent: unknown[] = [];
    const ctx = {
      ...k.ctx,
      env: { ...k.env, JOBS: { send: async (j: unknown) => void sent.push(j) } },
    } as unknown as typeof k.ctx;
    const created = await saveOrgCredential(ctx, auth, org.id, {
      provider: 'google',
      expectedRevision: 0,
      credentials: k.google('606060606'),
    });
    const v1 = await versionOf(created.id);
    await saveOrgCredential(ctx, auth, org.id, {
      provider: 'google',
      expectedRevision: 1,
      credentials: k.google('606060606'),
    });
    const v2 = await versionOf(created.id);
    expect(v2).not.toBe(v1);
    expect(sent.map((j) => (j as { checkId: string }).checkId)).toEqual([
      dailyCheckId(created.id, v1, ctx.clock.now()),
      dailyCheckId(created.id, v2, ctx.clock.now()),
    ]);
    // The old version's job finds the credential on v2: it records a check of v2, and the daily id differs.
    const queued: Job[] = [];
    await enqueueCredentialChecks(batcher(queued));
    const daily = queued.find(
      (j) => j.kind === 'wallet.credential_check' && j.credentialId === created.id,
    );
    for (const j of [...(sent as Job[]), daily as Job]) await runJob(j, jobCtx());
    const checks = await all<{ version_id: string }>(
      env.DB,
      'SELECT version_id FROM wallet_credential_checks WHERE credential_id = ?',
      [created.id],
    );
    expect(checks.map((c) => c.version_id).every((v) => v === v2)).toBe(true);
    expect(checks).toHaveLength(2);
  });
});
