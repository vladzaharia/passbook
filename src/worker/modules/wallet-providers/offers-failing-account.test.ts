import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixture, restore } from './google-runtime-test-fixtures.ts';
import { listWalletOffers } from './offers.ts';

const failing = vi.hoisted(() => ({ value: false }));
// The check rows are tested in account-health.test.ts; here only the offers path's use of the answer.
vi.mock('./repo-account-health.ts', () => ({ accountCheckFailing: async () => failing.value }));

afterEach(() => {
  failing.value = false;
  for (const undo of restore.splice(0).reverse()) undo();
  vi.unstubAllGlobals();
});

describe('Q6: the offers path', () => {
  it('lists no Google offer while the account is failing, and lists it again when it is not', async () => {
    const { f } = await fixture();
    const providers = async () =>
      (await listWalletOffers(f.kit.ctx, f.pass.id)).map((o) => o.provider);
    expect(await providers()).toEqual(['google']);
    failing.value = true;
    expect(await providers()).toEqual([]);
    failing.value = false;
    expect(await providers()).toEqual(['google']);
  });
});
