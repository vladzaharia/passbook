import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeOrg, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import type { JobOf } from '../../jobs/types.ts';
import { all, run } from '../../platform/db.ts';
import { createLogger } from '../../platform/log.ts';
import { grantKitMembership } from '../passes/apple-release-test-fixtures.ts';
import { setupTenantTestAuth, type TenantTestAuth } from '../passes/tenant-test-fixtures.ts';
import { enrolOn } from './enrolled-test-fixtures.ts';
import { runUncertainRecheck } from './health.ts';
import { handleUncertainRecheck } from './health-job.ts';
import {
  claimWalletOperation,
  markWalletClaimUncertain,
  newWalletClaimHandle,
  readWalletPassSnapshot,
} from './instance.ts';
import { fixture, reference } from './instance-test-fixtures.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { UNCERTAIN_GRACE_MS } from './repo-sync-uncertain.ts';
import { walletJobCtx } from './wallet-job-ctx-test-fixtures.ts';

type F = Awaited<ReturnType<typeof fixture>>;
let f: F;
let auth: TenantTestAuth;
let app: ReturnType<typeof createApp>;
const undo: (() => void)[] = [];

beforeAll(async () => {
  f = await fixture();
  auth = await setupTenantTestAuth(f.kit);
  app = createApp({ stores: auth.stores, clock: f.kit.clock });
}, 30_000);
// The hourly recheck counter is keyed by org, mode and provider: each test starts it from zero.
beforeEach(async () => {
  await run(f.kit.env.DB, `DELETE FROM counters WHERE key LIKE 'walletrecheck:%'`);
});
afterEach(() => {
  for (const u of undo.splice(0)) u();
});

const orgId = () => f.pass.orgId;
const mode = () => f.pass.mode;
const url = (tail = '') => `https://wallet.test/api/v1/orgs/${orgId()}/wallet-health${tail}`;
const get = (headers: Record<string, string>) => app.request(url(), { headers }, f.kit.env);
const recheck = (headers: Record<string, string>, provider = 'samsung') =>
  app.request(
    url(`/${provider}/recheck`),
    { method: 'POST', headers: { ...headers, 'content-type': 'application/json' } },
    f.kit.env,
  );
const open = () => undo.push(setWalletProvidersEnabledForTest(true));
/** An operation the first attempt left uncertain, past the grace window. */
async function seedDueUncertain() {
  // One instance per pass and provider: each seeded operation gets its own pass.
  const pass = await f.kit.pass();
  const snap = await readWalletPassSnapshot(f.kit.env.DB, { ...f.scope, passId: pass.id });
  if (!snap) throw new Error('Seeded pass has no snapshot');
  const op = await f.create({
    ...f.proof,
    passId: pass.id,
    passVersion: snap.passVersion,
    passRevision: snap.passRevision,
    passCredentialGeneration: snap.credentialGeneration,
    lifecycleGeneration: snap.lifecycleGeneration,
    issuingReleaseId: snap.issuingReleaseId,
  });
  const claim = { ...reference(op), claimHandle: newWalletClaimHandle(), now: f.kit.clock.now() };
  expect(await claimWalletOperation(walletJobCtx(f.kit.env.DB), claim)).toBe('claimed');
  expect(await markWalletClaimUncertain(walletJobCtx(f.kit.env.DB), claim)).toBe(true);
  f.kit.clock.advance(UNCERTAIN_GRACE_MS + 1);
  return op;
}
const stateOf = async (id: string) =>
  (
    await all<{ state: string }>(
      f.kit.env.DB,
      'SELECT state FROM wallet_provider_instance_operations WHERE id = ?',
      [id],
    )
  )[0]?.state;

describe('wallet health', () => {
  it('lists no wallet that is not released', async () => {
    const res = await get(auth.admin({ mode: mode() }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
  });

  it('refuses anonymous callers and plain users', async () => {
    open();
    expect((await get({})).status).toBe(401);
    await expectProblem(await get(auth.user()), 403, 'FORBIDDEN');
  });

  it('reports queued, then uncertain, and settles only past the grace window', async () => {
    open();
    const admin = auth.admin({ mode: mode() });
    const op = await f.create();
    const samsung = async () => {
      const body = (await (await get(admin)).json()) as {
        items: {
          provider: string;
          tone: string;
          queued: number;
          uncertain: number;
          uncertainWaiting: number;
        }[];
      };
      return body.items.find((i) => i.provider === 'samsung');
    };
    expect(await samsung()).toMatchObject({ queued: 1, uncertain: 0, tone: 'ok' });

    const now = f.kit.clock.now();
    const claim = { ...reference(op), claimHandle: newWalletClaimHandle(), now };
    expect(await claimWalletOperation(walletJobCtx(f.kit.env.DB), claim)).toBe('claimed');
    expect(await markWalletClaimUncertain(walletJobCtx(f.kit.env.DB), claim)).toBe(true);
    expect(await samsung()).toMatchObject({
      queued: 0,
      uncertain: 1,
      uncertainWaiting: 1,
      tone: 'attention',
    });

    // Inside the window nothing is queued: the first attempt may still be in flight.
    const queue = f.kit.queue;
    const early = await recheck(admin);
    expect(early.status).toBe(202);
    expect(await early.json()).toEqual({ due: 0, waiting: 1 });
    expect(queue.sent).toEqual([]);

    f.kit.clock.advance(UNCERTAIN_GRACE_MS + 1);
    const late = await recheck(admin);
    expect(await late.json()).toEqual({ due: 1, waiting: 0 });
    const job = queue.sent[0] as JobOf<'wallet.uncertain_recheck'>;
    expect(job).toMatchObject({ kind: 'wallet.uncertain_recheck', provider: 'samsung' });
    await handleUncertainRecheck(job, walletJobCtx(f.kit.env.DB));
    expect(await samsung()).toMatchObject({ uncertain: 0, queued: 1 });
    const audits = await all<{ detail: string }>(
      f.kit.env.DB,
      `SELECT detail FROM audit_log WHERE org_id = ? AND action = 'wallet.uncertain_recheck'`,
      [orgId()],
    );
    expect(audits).toHaveLength(2);
  });

  it('refuses a recheck of a wallet that is not released', async () => {
    await expectProblem(
      await recheck(auth.admin({ mode: mode() })),
      403,
      'WALLET_PROVIDER_DISABLED',
    );
  });

  async function member(roles: string[]) {
    const user = await makeUser(f.kit.fx);
    const session = await makeSession(f.kit.fx, { userId: user.id });
    await grantKitMembership(f.kit, orgId(), user.id, roles as never);
    return { ...session.headers, origin: 'https://wallet.test', 'x-passbook-mode': mode() };
  }
  const audits = async () =>
    (
      await all<{ id: string }>(
        f.kit.env.DB,
        `SELECT id FROM audit_log WHERE org_id = ? AND action = 'wallet.uncertain_recheck'`,
        [orgId()],
      )
    ).length;

  it('lets a pass operator recheck, queues once and audits it', async () => {
    open();
    const operator = await member(['pass_operator']);
    await seedDueUncertain();
    const before = await audits();
    const sent = f.kit.queue.sent.length;
    const res = await recheck(operator);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ due: 1, waiting: 0 });
    expect(await audits()).toBe(before + 1);
    expect(f.kit.queue.sent).toHaveLength(sent + 1);
    expect(f.kit.queue.sent.at(-1)).toMatchObject({
      kind: 'wallet.uncertain_recheck',
      orgId: orgId(),
      provider: 'samsung',
    });
  });

  it('refuses a viewer a recheck, and a pass operator the read', async () => {
    open();
    await expectProblem(await recheck(await member(['read_only'])), 403, 'FORBIDDEN');
    await expectProblem(await get(await member(['pass_operator'])), 403, 'FORBIDDEN');
  });

  it('refuses another organization', async () => {
    open();
    const other = await makeOrg(f.kit.fx, { name: 'Other Org' });
    const res = await app.request(
      `https://wallet.test/api/v1/orgs/${other.id}/wallet-health`,
      { headers: auth.admin({ mode: mode() }) },
      f.kit.env,
    );
    await expectProblem(res, 403, 'FORBIDDEN');
  });

  it('serves the Test and Live modes apart', async () => {
    open();
    const tag = `${Date.now()}`;
    await enrolOn(
      f.kit,
      { ...f.auth, mode: 'test' },
      {
        provider: 'samsung',
        expectedRevision: 0,
        credentials: { ...f.samsung, partnerId: `p${tag}`, cardId: `c${tag}` },
      },
    );
    const view = async (m: 'live' | 'test') =>
      (await (await get(auth.admin({ mode: m }))).json()) as {
        items: { provider: string; mode: string; queued: number }[];
      };
    const live = await view('live');
    const test = await view('test');
    expect(live.items).toHaveLength(1);
    expect(live.items[0]).toMatchObject({ provider: 'samsung', mode: 'live' });
    expect(live.items[0]?.queued).toBeGreaterThan(0);
    expect(test.items).toEqual([
      expect.objectContaining({ provider: 'samsung', mode: 'test', queued: 0 }),
    ]);
  });

  it('answers a key with wallet:read to read and passes:write to recheck, nothing else', async () => {
    open();
    const read = await auth.apiKey({ orgId: orgId(), scopes: ['wallet:read'], mode: mode() });
    const write = await auth.apiKey({ orgId: orgId(), scopes: ['passes:write'], mode: mode() });
    const wrong = await auth.apiKey({ orgId: orgId(), scopes: ['passes:read'], mode: mode() });
    expect((await get(read)).status).toBe(200);
    expect((await get(wrong)).status).toBe(403);
    expect((await recheck(read)).status).toBe(403);
    const res = await recheck(write);
    expect(res.status).toBe(202);
    const otherOrg = await makeOrg(f.kit.fx, { name: 'Key Other' });
    const foreign = await auth.apiKey({
      orgId: otherOrg.id,
      scopes: ['wallet:read'],
      mode: mode(),
    });
    expect((await get(foreign)).status).toBe(403);
  });

  it('limits rechecks to ten an hour', async () => {
    open();
    const admin = auth.admin({ mode: mode() });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) statuses.push((await recheck(admin)).status);
    expect(statuses).toEqual([...Array(10).fill(202), 429]);
  });

  it('skips the job and leaves an uncertain operation untouched when the wallet was turned off', async () => {
    undo.push(setWalletProvidersEnabledForTest(false));
    const op = await seedDueUncertain();
    const lines: string[] = [];
    const ctx = {
      ...walletJobCtx(f.kit.env.DB),
      clock: f.kit.clock,
      log: createLogger({}, { sink: (line) => lines.push(line) }),
    };
    const job = { orgId: orgId(), mode: mode(), provider: 'samsung' as const };
    expect(await runUncertainRecheck(ctx, job)).toBe(0);
    expect(await stateOf(op.id)).toBe('uncertain');
    const skipped = lines
      .map((l) => JSON.parse(l))
      .filter((l) => l.code === 'WALLET_UNCERTAIN_RECHECK_SKIPPED');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ orgId: orgId(), reason: 'not_released' });
  });
});
