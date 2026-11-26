// CAND-1: a Samsung card released by the platform retires like one a person released: a delete sends DELETED
// and leaves its tombstone, on an enrolment (a source, no legacy envelope) as on the legacy model.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockWallets } from '../../../../test/mock-wallets/index.ts';
import { first } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { deletePass } from '../passes/service.ts';
import { setupSamsungCallbacks } from './callbacks-test-fixtures.ts';
import { SYSTEM_REVIEWER } from './projection-system-authority.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { drainWalletProviderSync } from './sync.ts';

beforeAll(() => {
  setWalletProvidersEnabledForTest(true);
});
afterEach(() => vi.unstubAllGlobals());

describe.each([
  ['a legacy envelope', false],
  ['an enrolment', true],
] as const)('a Samsung system release on %s', (_model, enrolled) => {
  it('sends DELETED for a delete and retires the card with its tombstone', async () => {
    const t = await setupSamsungCallbacks({ enrolled, system: true });
    expect(
      await first(
        t.kit.env.DB,
        `SELECT 1 FROM template_releases WHERE provider = 'samsung' AND org_id = ? AND created_by = ?`,
        [t.kit.org.id, SYSTEM_REVIEWER],
      ),
    ).not.toBeNull();
    const mock = createMockWallets();
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== 'tsapi-card.walletsvc.samsung.com')
        throw new Error(`Unexpected request to ${url.hostname}`);
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
    await deletePass(ctx, { type: 'system', id: null }, t.pass.id, null);
    await drainWalletProviderSync(ctx);
    await drainWalletProviderSync(ctx);
    expect(mock.samsungRefs.get(t.refId)?.state).toBe('DELETED');
    expect(await first(t.kit.env.DB, 'SELECT 1 FROM wallet_samsung_tombstones')).not.toBeNull();
  });
});
