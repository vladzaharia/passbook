import { describe, expect, it } from 'vitest';
import { fidelityReport } from '@/passkit/wallets/fidelity.ts';
import { googleCompiler } from '@/passkit/wallets/google/compilers.ts';
import { samsungCompiler } from '@/passkit/wallets/samsung/index.ts';
import { viewOf } from '@/passkit/wallets/view-fixtures.ts';
import type { WalletOut } from '../../../../channel-previews/wallet-kit.ts';
import { blockedFixes } from './blocked-fixes.ts';
import type { WalletEnv } from './wallets-env.ts';

const NOW = new Date('2026-11-17T10:00:00Z');

async function env(
  target: 'google' | 'samsung',
  wallets: Record<string, unknown>,
  slug = 'starter-store-card',
): Promise<WalletEnv> {
  const view = await viewOf(slug, { wallets });
  const compiler = target === 'google' ? googleCompiler : samsungCompiler;
  const compiled = compiler.compile(view, { now: NOW, omit: [] });
  const report = fidelityReport({
    target,
    compiler,
    views: [view],
    wallets: wallets as never,
    now: NOW,
  });
  return {
    target,
    out: { compiled, report, view } as unknown as WalletOut,
    block: wallets,
    edit: () => undefined,
    assetBase: '',
    readOnly: false,
  };
}

describe('Blocked fixes', () => {
  it('goes to the first missing role, or stops requiring the type', async () => {
    const e = await env('google', { schema: 1, required: ['type'], google: { type: 'event' } });
    expect(e.out.report.status.kind).toBe('blocked');
    const fixes = blockedFixes(e, e.out.report);
    expect(fixes.map((f) => f.label)).toEqual(['Go to Event name', "Don't require Wallet type"]);
  });

  it('goes to a required role that has no value, or stops requiring it', async () => {
    const e = await env('samsung', { schema: 1, required: ['role.giftCardPin'] });
    expect(e.out.report.status.kind).toBe('blocked');
    expect(blockedFixes(e, e.out.report).map((f) => f.label)).toEqual([
      'Go to Card PIN',
      "Don't require Card PIN",
    ]);
  });

  it('has nothing to fix when the wallet is not blocked', async () => {
    const e = await env('samsung', { schema: 1 });
    expect(blockedFixes(e, e.out.report)).toEqual([]);
  });
});
