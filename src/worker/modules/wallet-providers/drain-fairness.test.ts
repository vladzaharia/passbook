// A large reissue in org A, then a void in org B: org B's void goes out in the next single drain tick although
// more than one tick of org A's updates is queued ahead of it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { all, first } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { voidPass } from '../passes/service.ts';
import { fixture, mock, restore, tokenOf } from './google-runtime-test-fixtures.ts';
import { issueWalletOffer, listWalletOffers } from './offers.ts';
import { drainWalletProviderSync } from './sync.ts';
import { handleWalletReissue } from './wallet-reissue.ts';

afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
  vi.unstubAllGlobals();
});

const system = { type: 'system', id: null } as const;
const COPIES_A = 45; // more than the drain's 30 a tick

describe('cross-org fairness', () => {
  it("org B's void is sent in the first tick after it, behind a 45-copy reissue of org A", async () => {
    const { f: a } = await fixture();
    const { f: b } = await fixture();
    const tap = async (f: typeof a, id: string) => {
      const [offer] = await listWalletOffers(f.kit.ctx, id);
      await issueWalletOffer(f.kit.ctx, offer?.href.split('/')[2] ?? '', 'google');
    };
    await issueWalletOffer(a.kit.ctx, await tokenOf(a), 'google');
    for (let n = 1; n < COPIES_A; n++) {
      const p = await a.kit.pass({ holderEmail: `a${n}@example.test` });
      await tap(a, p.id);
    }
    await issueWalletOffer(b.kit.ctx, await tokenOf(b), 'google');
    const ctx = jobCtxOf(a.kit);
    for (let n = 0; n < 6; n++) await drainWalletProviderSync(ctx);
    const settled = await first<{ n: number }>(
      a.kit.env.DB,
      "SELECT COUNT(*) AS n FROM wallet_provider_instance_operations WHERE state IN ('pending','retry')",
    );
    expect(settled?.n).toBe(0);

    // Org A's whole reissue, every continuation run at once (no pacing), so its updates are all queued.
    const send = vi.spyOn(ctx.env.JOBS, 'send');
    const job = {
      kind: 'wallet.reissue' as const,
      reissueId: 'big-a',
      orgId: a.kit.org.id,
      mode: 'live' as const,
      provider: 'google' as const,
    };
    send.mockResolvedValue(undefined as never);
    await handleWalletReissue(job, ctx);
    for (let guard = 0; guard < 10; guard++) {
      const next = send.mock.calls.at(-1)?.[0] as typeof job | undefined;
      const before = send.mock.calls.length;
      if (next?.kind !== 'wallet.reissue') break;
      await handleWalletReissue(next, ctx);
      if (send.mock.calls.length === before) break;
    }
    send.mockRestore();
    const queuedA = await first<{ n: number }>(
      a.kit.env.DB,
      `SELECT COUNT(*) AS n FROM wallet_provider_instance_operations op JOIN wallet_provider_instances i
        ON i.id = op.instance_id WHERE i.org_id = ? AND op.kind = 'upsert' AND op.state IN ('pending','retry')`,
      [a.kit.org.id],
    );
    expect(queuedA?.n).toBe(COPIES_A);

    // Then org B voids, queued after every one of org A's updates.
    await voidPass(jobCtxOf(b.kit), system, b.pass.id, {
      orgId: b.kit.org.id,
      mode: 'live',
      principal: 'session',
    });
    const putsBefore = mock.requests.filter((r) => r.method === 'PUT').length;
    await drainWalletProviderSync(ctx); // one tick
    const bRevoke = await all<{ state: string }>(
      b.kit.env.DB,
      `SELECT op.state FROM wallet_provider_instance_operations op JOIN wallet_provider_instances i
        ON i.id = op.instance_id WHERE i.org_id = ? AND op.kind = 'revoke'`,
      [b.kit.org.id],
    );
    expect(bRevoke.map((r) => r.state)).toEqual(['succeeded']);
    expect(mock.requests.filter((r) => r.method === 'PUT').length).toBe(putsBefore + 1);
    // And org A was still behind: the tick could not have reached B by draining A first.
    const leftA = await first<{ n: number }>(
      a.kit.env.DB,
      `SELECT COUNT(*) AS n FROM wallet_provider_instance_operations op JOIN wallet_provider_instances i
        ON i.id = op.instance_id WHERE i.org_id = ? AND op.kind = 'upsert' AND op.state IN ('pending','retry')`,
      [a.kit.org.id],
    );
    expect(leftA?.n).toBeGreaterThan(0);
  }, 180_000);
});
