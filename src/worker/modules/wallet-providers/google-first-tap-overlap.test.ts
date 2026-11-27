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
  /** Called with the tap's own run result, before it starts to wait. */
  afterTap: (_result: string): void => undefined,
  /** The next read of the operation fails once. */
  failRead: false,
}));
vi.mock('./instance.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('./instance.ts')>();
  return {
    ...real,
    getWalletOperation: (...args: Parameters<typeof real.getWalletOperation>) => {
      if (!overlap.failRead) return real.getWalletOperation(...args);
      overlap.failRead = false;
      return Promise.reject(new Error('D1 down'));
    },
  };
});
vi.mock('../../jobs/wallet-first-tap.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../jobs/wallet-first-tap.ts')>();
  return {
    ...real,
    runFirstTapUpsert: async (ctx: ServiceContext, op: WalletOperation, pass: never) => {
      await overlap.beforeTap();
      const result = await real.runFirstTapUpsert(ctx, op, pass);
      overlap.afterTap(result);
      return result;
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
  };
  const seen: string[] = [];
  // The cron's provider call ends only once the tap has lost the claim.
  overlap.afterTap = (result) => {
    seen.push(result);
    release();
  };
  const location = await issueWalletOffer(kit.ctx, token, 'google');
  await cron;
  expect(seen).toEqual(['not_claimed']);
  expect(location).toMatch(/^https:\/\/pay\.google\.com\/gp\/v\/save\//);
});

it('logs a failed wait read as its own event, not as a failed upsert', async () => {
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
  };
  overlap.afterTap = () => {
    overlap.failRead = true;
    release();
  };
  const warn = vi.spyOn(kit.ctx.log, 'warn');
  await issueWalletOffer(kit.ctx, token, 'google').catch(() => undefined);
  await cron;
  const events = warn.mock.calls.map((call) => call[0]);
  expect(events).toContain('wallet.google_first_tap_wait_failed');
  expect(events).not.toContain('wallet.google_first_tap_failed');
});
