// Architecture 6.1, Samsung column, end to end: the real send to the mock Samsung server for each row, the
// door already denying before the provider is called, and what Get Card Data still answers for a kept ref.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockWallets } from '../../../../test/mock-wallets/index.ts';
import { countQueries } from '../../jobs/query-counter.ts';
import { first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { startCredentialTransfer } from '../passes/credential-transfer.ts';
import { removePass, restorePass } from '../passes/remove.ts';
import { deletePass, unvoidPass, updatePass, voidPass } from '../passes/service.ts';
import { setupSamsungCallbacks } from './callbacks-test-fixtures.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { drainWalletProviderSync } from './sync.ts';
import { finishWalletProviderRetirement } from './sync-operation-retirement.ts';
import { handleWalletReissue, QUERIES_PER_COPY } from './wallet-reissue.ts';

/** Runs once between a revoke's completion and its finish: what lands in that window, and whether the run dies there. */
const tombstones = vi.hoisted(() => ({ calls: 0 }));
vi.mock('./callbacks-tombstone.ts', async (original) => {
  const real = await original<typeof import('./callbacks-tombstone.ts')>();
  return {
    ...real,
    persistSamsungTombstone: (...args: Parameters<typeof real.persistSamsungTombstone>) => {
      tombstones.calls++;
      return real.persistSamsungTombstone(...args);
    },
  };
});

const window = vi.hoisted(() => ({ run: null as null | (() => Promise<void>), crash: false }));
vi.mock('./sync-lag.ts', async (original) => {
  const real = await original<typeof import('./sync-lag.ts')>();
  return {
    ...real,
    recordSyncLag: async (...args: Parameters<typeof real.recordSyncLag>) => {
      const run = window.run;
      window.run = null;
      if (run) await run();
      if (window.crash) {
        window.crash = false;
        throw new Error('crash between the completion and the finish');
      }
      return real.recordSyncLag(...args);
    },
  };
});

beforeAll(() => {
  setWalletProvidersEnabledForTest(true);
});
afterEach(() => vi.unstubAllGlobals());

const system = { type: 'system', id: null } as const;
type T = Awaited<ReturnType<typeof setupSamsungCallbacks>>;

/** A tapped, promoted Samsung card in the GB market, with Samsung as the mock server. */
async function card() {
  const t = await setupSamsungCallbacks();
  const mock = createMockWallets();
  const denied: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== 'tsapi-card.walletsvc.samsung.com')
      throw new Error(`Unexpected request to ${url.hostname}`);
    if (url.pathname.endsWith('/updates')) {
      const pass = await first<{
        status: string;
        removed_at: number | null;
        deleted_at: number | null;
      }>(t.kit.env.DB, 'SELECT status, removed_at, deleted_at FROM passes WHERE id = ?', [
        t.pass.id,
      ]);
      denied.push(`${pass?.status}/${pass?.removed_at === null ? 'kept' : 'removed'}`);
    }
    const { redirect: _r, signal: _s, ...rest } = init ?? {};
    return mock.handle(new Request(`http://mock.test${url.pathname}`, rest));
  });
  const ctx = jobCtxOf(t.kit);
  const added = await t.call({
    method: 'POST',
    token: await t.token({ method: 'POST' }),
    query: '?cc2=gb&event=ADDED',
  });
  expect(added.status).toBe(200);
  await drainWalletProviderSync(ctx);
  await drainWalletProviderSync(ctx);
  const sent = () => mock.samsungRefs.get(t.refId)?.state;
  const live = (t0: T) => ({ orgId: t0.kit.org.id, mode: 'live', principal: 'session' }) as const;
  const getCard = async () => t.call({ token: await t.token() });
  return { t, mock, ctx, sent, denied, scope: live(t), getCard };
}

const edit = (t: T, ctx: ReturnType<typeof jobCtxOf>) =>
  updatePass(ctx, system, t.pass.id, { input: { memberName: 'Edited Member' } }, { scope: null });

describe('6.1 Samsung: the state sent for each row', () => {
  it('an update reaches Samsung as UPDATED', async () => {
    const { sent } = await card();
    expect(sent()).toBe('UPDATED');
  });

  it('void: denied first, CANCELED sent, the op settles and the ref is still served; unvoid: ACTIVE', async () => {
    const { t, ctx, sent, denied, scope, getCard } = await card();
    await voidPass(ctx, system, t.pass.id, scope);
    await drainWalletProviderSync(ctx);
    expect(sent()).toBe('CANCELED');
    // Get Card Data still answers the kept ref (authenticated, no card data), and serves it again after an unvoid.
    expect((await getCard()).status).toBe(204);
    expect(denied.at(-1)).toBe('voided/kept');
    expect(
      await first(
        t.kit.env.DB,
        "SELECT 1 FROM wallet_provider_instance_operations WHERE kind = 'revoke' AND state = 'succeeded'",
      ),
    ).not.toBeNull();
    // No tombstone and the ref is kept, so an unvoid can bring the card back.
    expect(await first(t.kit.env.DB, 'SELECT 1 FROM wallet_samsung_tombstones')).toBeNull();
    expect(
      await first(t.kit.env.DB, 'SELECT 1 FROM wallet_samsung_fetch_refs WHERE retired_at IS NULL'),
    ).not.toBeNull();
    await unvoidPass(ctx, system, t.pass.id, scope);
    await drainWalletProviderSync(ctx);
    await drainWalletProviderSync(ctx);
    expect(sent()).toBe('ACTIVE');
    expect((await getCard()).status).toBe(200);
  });

  it('quarantine: CANCELED, as a void', async () => {
    const { t, ctx, sent } = await card();
    await run(t.kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [
      t.pass.id,
    ]);
    await drainWalletProviderSync(ctx);
    expect(sent()).toBe('CANCELED');
  });

  it('remove: denied first, DELETED sent; restore sends the card again', async () => {
    const { t, ctx, sent, denied } = await card();
    await removePass(ctx, system, t.pass.id, {}, null);
    await drainWalletProviderSync(ctx);
    expect(sent()).toBe('DELETED');
    expect(denied.at(-1)).toBe('voided/removed');
    await restorePass(ctx, system, t.pass.id, null);
    await drainWalletProviderSync(ctx);
    await drainWalletProviderSync(ctx);
    expect(['ACTIVE', 'UPDATED']).toContain(sent());
  });

  it('delete: DELETED sent and the instance retires with its tombstone', async () => {
    const { t, ctx, sent } = await card();
    await deletePass(ctx, system, t.pass.id, null);
    await drainWalletProviderSync(ctx);
    await drainWalletProviderSync(ctx);
    expect(sent()).toBe('DELETED');
    expect(await first(t.kit.env.DB, 'SELECT 1 FROM wallet_samsung_tombstones')).not.toBeNull();
  });

  /** A removal whose card was told DELETED, a restore landing before the finish, and optionally a crash there. */
  async function restoreInTheWindow(crash: boolean) {
    const { t, ctx, sent } = await card();
    window.run = async () => {
      await run(t.kit.env.DB, 'UPDATE passes SET removed_at = NULL WHERE id = ?', [t.pass.id]);
    };
    window.crash = crash;
    const before = tombstones.calls;
    await removePass(ctx, system, t.pass.id, {}, null);
    await drainWalletProviderSync(ctx);
    expect(sent()).toBe('DELETED');
    return { t, ctx, before };
  }

  // A tombstone is asked for before the send and again by the finish, because the card was told DELETED although
  // the pass reads as kept by then.
  it('the finish follows what was sent: a restore landing before it does not skip the tombstone', async () => {
    const { before } = await restoreInTheWindow(false);
    expect(tombstones.calls).toBe(before + 2);
  });

  it('crash recovery follows the recorded state, not the restored pass', async () => {
    const { t, ctx, before } = await restoreInTheWindow(true);
    expect(tombstones.calls).toBe(before + 1);
    const instance = await first<{ id: string; org_id: string; mode: 'live' | 'test'; v: number }>(
      t.kit.env.DB,
      'SELECT id, org_id, mode, desired_version AS v FROM wallet_provider_instances WHERE pass_id = ?',
      [t.pass.id],
    );
    if (!instance) throw new Error('Missing instance');
    await finishWalletProviderRetirement(ctx, {
      instanceId: instance.id,
      orgId: instance.org_id,
      mode: instance.mode,
      provider: 'samsung',
      version: instance.v,
    });
    expect(tombstones.calls).toBe(before + 2);
  });

  it('transfer: the old holder copy is sent DELETED', async () => {
    const { t, ctx, sent } = await card();
    const holder = await getHolderPass(t.kit.env.DB, t.pass.id, null);
    if (!holder) throw new Error('Missing holder snapshot');
    await startCredentialTransfer(
      ctx,
      system,
      t.pass.id,
      { holderEmail: 'new-holder@example.test', ownerUserId: null },
      null,
      { kind: 'tenant-holder', expected: holder },
    );
    await drainWalletProviderSync(ctx);
    await drainWalletProviderSync(ctx);
    expect(sent()).toBe('DELETED');
  });

  it('expiry: an update of an expired pass reaches Samsung as EXPIRED', async () => {
    const { t, ctx, sent } = await card();
    await edit(t, ctx);
    await run(
      t.kit.env.DB,
      `UPDATE pass_versions SET pass_json = json_set(pass_json, '$.expirationDate', ?) WHERE pass_id = ?`,
      [new Date(t.kit.clock.now() - 1000).toISOString(), t.pass.id],
    );
    await drainWalletProviderSync(ctx);
    expect(sent()).toBe('EXPIRED');
  });
});

describe('Samsung expiry boundary through the drain', () => {
  it('parks until the pass expires, then recompiles with no edit and sends EXPIRED', async () => {
    const { t, mock, ctx, sent } = await card();
    const soon = t.kit.clock.now() + 3_600_000;
    await edit(t, ctx);
    await run(
      t.kit.env.DB,
      `UPDATE pass_versions SET pass_json = json_set(pass_json, '$.expirationDate', ?) WHERE pass_id = ?`,
      [new Date(soon).toISOString(), t.pass.id],
    );
    await drainWalletProviderSync(ctx);
    expect(sent()).toBe('UPDATED');
    const parked = await first<{ next_attempt_at: number }>(
      t.kit.env.DB,
      `SELECT d.next_attempt_at FROM wallet_provider_instance_dirty d
       JOIN wallet_provider_instances i ON i.id = d.instance_id WHERE i.pass_id = ?`,
      [t.pass.id],
    );
    expect(parked?.next_attempt_at).toBe(soon);
    const mark = mock.requests.length;
    await drainWalletProviderSync(ctx);
    expect(mock.requests.length).toBe(mark);
    // The stored card-state read lapses in five minutes; the fixture's account cannot be read live again.
    await run(
      t.kit.env.DB,
      'UPDATE wallet_samsung_card_state SET verified_at = verified_at + 3600001, expires_at = expires_at + 3600001',
    );
    t.kit.clock.advance(3_600_001);
    await drainWalletProviderSync(ctx);
    await drainWalletProviderSync(ctx);
    expect(sent()).toBe('EXPIRED');
  });
});

describe('a new market wakes a parked instance (M1)', () => {
  it('delivers ADDED with a new country and the next drain sends, not at the next boundary', async () => {
    const { t, mock, ctx } = await card();
    const at = t.kit.clock.now() + 30 * 86_400_000;
    await edit(t, ctx);
    await run(
      t.kit.env.DB,
      `UPDATE pass_versions SET pass_json = json_set(pass_json, '$.expirationDate', ?) WHERE pass_id = ?`,
      [new Date(at).toISOString(), t.pass.id],
    );
    await run(t.kit.env.DB, 'UPDATE passes SET modified_at = modified_at + 1 WHERE id = ?', [
      t.pass.id,
    ]);
    await drainWalletProviderSync(ctx);
    const parked = await first<{ next_attempt_at: number }>(
      t.kit.env.DB,
      `SELECT d.next_attempt_at FROM wallet_provider_instance_dirty d
       JOIN wallet_provider_instances i ON i.id = d.instance_id WHERE i.pass_id = ?`,
      [t.pass.id],
    );
    expect(parked?.next_attempt_at).toBe(at);
    const mark = mock.requests.length;
    const added = await t.call({
      method: 'POST',
      token: await t.token({ method: 'POST' }),
      query: '?cc2=us&event=ADDED',
      requestId: 'second',
    });
    expect(added.status).toBe(200);
    await drainWalletProviderSync(ctx);
    await drainWalletProviderSync(ctx);
    expect(mock.requests.slice(mark).some((r) => r.path.startsWith('/US/'))).toBe(true);
    // The market that already had the card is not sent it again.
    expect(mock.requests.slice(mark).some((r) => r.path.startsWith('/GB/'))).toBe(false);
  });

  it('a new market that is also an expiry boundary sends the new state to every market', async () => {
    const { t, mock, ctx } = await card();
    const soon = t.kit.clock.now() + 3_600_000;
    await edit(t, ctx);
    await run(
      t.kit.env.DB,
      `UPDATE pass_versions SET pass_json = json_set(pass_json, '$.expirationDate', ?) WHERE pass_id = ?`,
      [new Date(soon).toISOString(), t.pass.id],
    );
    await drainWalletProviderSync(ctx);
    const added = await t.call({
      method: 'POST',
      token: await t.token({ method: 'POST' }),
      query: '?cc2=us&event=ADDED',
      requestId: 'second',
    });
    expect(added.status).toBe(200);
    await run(
      t.kit.env.DB,
      'UPDATE wallet_samsung_card_state SET verified_at = verified_at + 3600001, expires_at = expires_at + 3600001',
    );
    t.kit.clock.advance(3_600_001);
    const mark = mock.requests.length;
    await drainWalletProviderSync(ctx);
    await drainWalletProviderSync(ctx);
    const states = new Map(
      mock.requests
        .slice(mark)
        .filter((r) => r.path.endsWith('/updates'))
        .map((r) => [
          r.path.split('/')[1],
          (r.body as { card: { data: { state: string }[] } }).card.data[0]?.state,
        ]),
    );
    expect(states.get('GB')).toBe('EXPIRED');
    expect(states.get('US')).toBe('EXPIRED');
  });
});

describe('a Samsung copy fits the reissue batch budget', () => {
  it('spends no more queries per copy than the batch is sized for', async () => {
    const { t, ctx } = await card();
    const counter = countQueries(t.kit.env);
    await handleWalletReissue(
      {
        kind: 'wallet.reissue',
        reissueId: 'samsung-measured',
        orgId: t.kit.org.id,
        mode: 'live',
        provider: 'samsung',
      },
      { ...ctx, env: counter.env },
    );
    // Printed so the margin under QUERIES_PER_COPY stays visible in the run (32 of 40 when measured).
    // biome-ignore lint/suspicious/noConsole: the measured margin is this test's output
    console.info(
      `wallet reissue, one Samsung copy: ${counter.count()} of ${QUERIES_PER_COPY} queries`,
    );
    expect(counter.count()).toBeLessThanOrEqual(QUERIES_PER_COPY);
    expect(counter.count()).toBeGreaterThan(0);
  });
});
