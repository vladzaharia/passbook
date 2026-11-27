// A first tap whose pending upsert the minute cron claims between the row's creation and the tap's own claim.
import { afterEach, expect, it, vi } from 'vitest';
import type { ServiceContext } from '../../platform/service-context.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { fixture, restore, tokenOf } from './google-runtime-test-fixtures.ts';
import type { WalletOperation } from './instance-types.ts';
import { issueWalletOffer } from './offers.ts';
import { drainWalletProviderSync } from './sync.ts';

const overlap = vi.hoisted(() => ({
  /** Runs the cron to its provider call and returns once it holds the claim; set per test. */
  beforeTap: async (): Promise<void> => undefined,
}));
vi.mock('../../jobs/wallet-first-tap.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../jobs/wallet-first-tap.ts')>();
  return {
    ...real,
    runFirstTapUpsert: async (ctx: ServiceContext, op: WalletOperation, pass: never) => {
      await overlap.beforeTap();
      return real.runFirstTapUpsert(ctx, op, pass);
    },
  };
});

afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
  vi.unstubAllGlobals();
});

it('waits for the cron that holds the claim instead of answering preparing', async () => {
  const { f } = await fixture();
  const kit = f.kit;
  const token = await tokenOf(f);
  const provider = globalThis.fetch;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let cron: Promise<void> = Promise.resolve();
  overlap.beforeTap = async () => {
    let held: () => void = () => undefined;
    const inFlight = new Promise<void>((resolve) => {
      held = resolve;
    });
    let first = true;
    vi.stubGlobal('fetch', (...args: Parameters<typeof fetch>) => {
      if (!first) return provider(...args);
      first = false;
      held();
      return gate.then(() => provider(...args));
    });
    cron = drainWalletProviderSync(jobCtxOf(kit));
    await inFlight;
    overlap.beforeTap = async () => undefined;
    setTimeout(release, 0);
  };
  const location = await issueWalletOffer(kit.ctx, token, 'google');
  await cron;
  expect(location).toMatch(/^https:\/\/pay\.google\.com\/gp\/v\/save\//);
});
