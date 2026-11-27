import { expect, it } from 'vitest';
import { waitForClaimHolder } from './first-tap-claim-wait.ts';
import type { WalletOperation } from './instance-types.ts';

const row = (claimExpiresAt: number | null) =>
  ({ state: 'claimed', claimExpiresAt }) as unknown as WalletOperation;

/** A clock that only the waiting moves, and a budget that ends at `budget` ms. */
function run(read: () => WalletOperation, budget: number) {
  let t = 0;
  let reads = 0;
  return waitForClaimHolder({
    read: async () => {
      reads++;
      return read();
    },
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    over: () => t >= budget,
  }).then(() => ({ reads, t }));
}

it('backs off, so six members polling a whole budget stay far under the subrequest cap', async () => {
  const { reads } = await run(() => row(null), 15_000);
  expect(reads).toBeLessThanOrEqual(20);
  expect(reads * 6).toBeLessThan(200);
});

it('stops waiting once the holder’s claim has expired', async () => {
  const { reads, t } = await run(() => row(100), 15_000);
  expect(reads).toBe(3);
  expect(t).toBe(150);
});

it('returns at once when the row is final', async () => {
  const { reads } = await run(() => ({ state: 'succeeded' }) as unknown as WalletOperation, 15_000);
  expect(reads).toBe(1);
});
