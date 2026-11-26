// TURN-0 rollback: with Samsung `draining` in Live, a card already added still gets its void (CANCELED) and its
// removal (DELETED, then a tombstone), while an edit and a new reference never reach Samsung. Samsung's own calls
// on the card are answered without card data and a holder's DELETED is still recorded.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockWallets } from '../../../../test/mock-wallets/index.ts';
import { first } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { startCredentialTransfer } from '../passes/credential-transfer.ts';
import { deletePass, updatePass, voidPass } from '../passes/service.ts';
import { setupSamsungCallbacks } from './callbacks-test-fixtures.ts';
import { listWalletOffers } from './offers.ts';
import { setWalletProvidersEnabledForTest, setWalletReleaseForTest } from './provider-policy.ts';
import { drainWalletProviderSync } from './sync.ts';

const restore: (() => void)[] = [];
beforeAll(() => {
  setWalletProvidersEnabledForTest(true);
});
afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
  vi.unstubAllGlobals();
});

const system = { type: 'system', id: null } as const;

/** A tapped, promoted Samsung card in the GB market (released), then Samsung Live set to draining. */
async function drainingCard() {
  const t = await setupSamsungCallbacks();
  const mock = createMockWallets();
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== 'tsapi-card.walletsvc.samsung.com')
      throw new Error(`Unexpected request to ${url.hostname}`);
    calls.push(url.pathname);
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
  expect(mock.samsungRefs.get(t.refId)?.state).toBe('UPDATED');
  restore.push(setWalletReleaseForTest('draining', { provider: 'samsung', mode: 'live' }));
  const scope = { orgId: t.kit.org.id, mode: 'live', principal: 'session' } as const;
  const sent = () => mock.samsungRefs.get(t.refId)?.state;
  const updates = () => calls.filter((p) => p.endsWith('/updates')).length;
  return { t, ctx, scope, sent, updates };
}

describe('Samsung draining in Live', () => {
  it('refuses an edit and every new offer, then still sends a void', async () => {
    const { t, ctx, scope, sent, updates } = await drainingCard();
    const before = updates();
    await updatePass(ctx, system, t.pass.id, { input: { memberName: 'Edited' } }, { scope: null });
    await drainWalletProviderSync(ctx);
    expect(updates()).toBe(before);
    expect(await listWalletOffers(t.kit.ctx, t.pass.id)).toEqual([]);
    await voidPass(ctx, system, t.pass.id, scope);
    await drainWalletProviderSync(ctx);
    expect(sent()).toBe('CANCELED');
  });

  it('sends DELETED for a delete and retires the card with its tombstone', async () => {
    const { t, ctx, sent } = await drainingCard();
    await deletePass(ctx, system, t.pass.id, null);
    await drainWalletProviderSync(ctx);
    await drainWalletProviderSync(ctx);
    expect(sent()).toBe('DELETED');
    expect(await first(t.kit.env.DB, 'SELECT 1 FROM wallet_samsung_tombstones')).not.toBeNull();
  });

  it('sends DELETED for the old holder copy of a transfer', async () => {
    const { t, ctx, sent } = await drainingCard();
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

  it('answers Get Card Data without card data, and records a holder DELETED without promoting', async () => {
    const { t } = await drainingCard();
    expect((await t.call({ token: await t.token() })).status).toBe(204);
    const deleted = await t.call({
      method: 'POST',
      token: await t.token({ method: 'POST' }),
      query: '?cc2=gb&event=DELETED',
    });
    expect(deleted.status).toBe(200);
    expect(
      await first(
        t.kit.env.DB,
        "SELECT 1 FROM wallet_samsung_callback_receipts WHERE event = 'DELETED' AND instance_id IN (SELECT id FROM wallet_provider_instances WHERE pass_id = ?)",
        [t.pass.id],
      ),
    ).not.toBeNull();
  });

  it('calls Samsung for nothing once dark', async () => {
    const { t, ctx, scope, updates } = await drainingCard();
    restore.push(setWalletReleaseForTest('dark', { provider: 'samsung', mode: 'live' }));
    const before = updates();
    await voidPass(ctx, system, t.pass.id, scope);
    await drainWalletProviderSync(ctx);
    expect(updates()).toBe(before);
  });
});
