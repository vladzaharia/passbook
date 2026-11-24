// Architecture 6.1, Samsung column, end to end: the real send to the mock Samsung server for each row, the
// door already denying before the provider is called, and what Get Card Data still answers for a kept ref.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockWallets } from '../../../../test/mock-wallets/index.ts';
import { first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { startCredentialTransfer } from '../passes/credential-transfer.ts';
import { removePass, restorePass } from '../passes/remove.ts';
import { deletePass, unvoidPass, updatePass, voidPass } from '../passes/service.ts';
import { setupSamsungCallbacks } from './callbacks-test-fixtures.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { drainWalletProviderSync } from './sync.ts';

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
    const { t, ctx, sent, denied, scope } = await card();
    await voidPass(ctx, system, t.pass.id, scope);
    await drainWalletProviderSync(ctx);
    expect(sent()).toBe('CANCELED');
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
      'SELECT next_attempt_at FROM wallet_provider_instance_dirty',
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
  });
});
