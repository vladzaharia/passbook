import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { createServiceContext } from '../../platform/service-context.ts';
import { handleGoogleReconcile, RECONCILE_MAX_RUNS } from './google-reconcile-job.ts';

// 35 classes: the first 30 never get written, so they stay in the list; the last 5 can be.
const CLASSES = Array.from({ length: 35 }, (_, i) => String(i).padStart(2, '0'));
const marked: string[] = [];
vi.mock('./repo-google-reconcile.ts', () => ({
  listStaleGoogleClassInstances: async (_db: unknown, p: { after?: string }, limit: number) =>
    CLASSES.filter((c) => c > (p.after ?? ''))
      .slice(0, limit)
      .map((c) => ({ instanceId: `i${c}`, classIdHash: c })),
  markInstanceDirty: async (_db: unknown, id: string) => {
    marked.push(id);
  },
}));

const job = {
  kind: 'wallet.google_reconcile' as const,
  orgId: 'o',
  mode: 'live' as const,
  templateId: 't',
  version: '1',
  generation: 2,
};

describe('wallet.google_reconcile', () => {
  it('walks past classes that cannot be written and reaches the ones behind them', async () => {
    marked.length = 0;
    const sent: unknown[] = [];
    const ctx = createServiceContext({
      ...env,
      JOBS: { send: async (m: unknown) => sent.push(m) },
    } as never);
    await handleGoogleReconcile(job, ctx);
    expect(sent).toHaveLength(1);
    await handleGoogleReconcile(sent[0] as typeof job, ctx);
    // The second page was short: the walk ends.
    expect(sent).toHaveLength(1);
    expect(marked).toEqual(CLASSES.map((c) => `i${c}`));
  });

  it('stops at the cap and logs a stable code', async () => {
    const sent: unknown[] = [];
    const ctx = createServiceContext({
      ...env,
      JOBS: { send: async (m: unknown) => sent.push(m) },
    } as never);
    const warn = vi.spyOn(ctx.log, 'warn');
    await handleGoogleReconcile({ ...job, runs: RECONCILE_MAX_RUNS - 1 }, ctx);
    expect(sent).toEqual([]);
    expect(
      warn.mock.calls.some(
        (c) => (c[1] as { code?: string }).code === 'WALLET_GOOGLE_RECONCILE_CAP',
      ),
    ).toBe(true);
  });
});
