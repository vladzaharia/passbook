import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { WalletOperation } from '../modules/wallet-providers/instance-types.ts';
import { jobGrant } from '../platform/authority.ts';
import {
  createJobContext,
  createServiceContext,
  isJobContext,
} from '../platform/service-context.ts';
import { runFirstTapUpsert } from './wallet-first-tap.ts';

const op = (over: Partial<WalletOperation>) =>
  ({
    provider: 'google',
    kind: 'upsert',
    passId: 'p1',
    orgId: 'o1',
    mode: 'live',
    ...over,
  }) as WalletOperation;
const pass = { id: 'p1', orgId: 'o1', mode: 'live' as const };

describe('runFirstTapUpsert', () => {
  const ctx = createServiceContext(env);
  it.each([
    ['another pass', { passId: 'p2' }],
    ['another org', { orgId: 'o2' }],
    ['another mode', { mode: 'test' as const }],
    ['a revoke', { kind: 'revoke' as const }],
    ['another provider', { provider: 'samsung' as const }],
  ])('refuses %s', async (_name, over) => {
    await expect(runFirstTapUpsert(ctx, op(over), pass)).rejects.toThrow(/only the pass/);
  });
});

describe('a narrowed job context', () => {
  const ctx = createJobContext(env, 'x', { allowedPurposes: ['org_mode.job.wallet.record'] });
  it('refuses every other purpose, closed-org work included', () => {
    for (const purpose of ['org_mode.job.org.purge_void', 'org_mode.job.wallet.revoke'])
      expect(() => jobGrant(ctx, { purpose, job: 'x', orgId: 'o', mode: 'live' } as never)).toThrow(
        /may not use/,
      );
  });
  it('is no job context for the deferred grants and creates that need the full one', () => {
    expect(isJobContext(ctx)).toBe(false);
    expect(isJobContext(createJobContext(env, 'x'))).toBe(true);
  });
  it('lets its own purpose through the check', () => {
    expect(() =>
      jobGrant(ctx, {
        purpose: 'org_mode.job.wallet.record',
        job: 'x',
        orgId: 'o',
        mode: 'live',
        tables: ['wallet_provider_instances'],
        checks: [],
      } as never),
    ).not.toThrow(/may not use/);
  });
});
