// Q5 under load: one org's reissue must not delay another org's void. The drain sends voids first and gives
// each org its turn (repo-instance.ts), whatever the order the operations were queued in.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { updatePass, voidPass } from '../passes/service.ts';
import { fixture, restore, tokenOf } from './google-runtime-test-fixtures.ts';
import { listDueWalletOperations } from './instance.ts';
import { issueWalletOffer } from './offers.ts';
import { handleWalletReissue } from './wallet-reissue.ts';

afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
  vi.unstubAllGlobals();
});

const system = { type: 'system', id: null } as const;

describe('the drain order', () => {
  it('sends a void ahead of a larger reissue queued earlier, and alternates orgs for updates', async () => {
    // Org A: three copies with an update each, queued first. Org B: one copy to void, queued last.
    const { f: a } = await fixture();
    const tap = async (f: typeof a, id: string) => {
      const [offer] = await (await import('./offers.ts')).listWalletOffers(f.kit.ctx, id);
      await issueWalletOffer(f.kit.ctx, offer?.href.split('/')[2] ?? '', 'google');
    };
    await issueWalletOffer(a.kit.ctx, await tokenOf(a), 'google');
    const extra = [
      await a.kit.pass({ holderEmail: 'b@example.test' }),
      await a.kit.pass({ holderEmail: 'c@example.test' }),
    ];
    for (const p of extra) await tap(a, p.id);
    const ctxA = jobCtxOf(a.kit);
    await handleWalletReissue(
      {
        kind: 'wallet.reissue',
        reissueId: 'big',
        orgId: a.kit.org.id,
        mode: 'live',
        provider: 'google',
      },
      ctxA,
    );
    const { f: b } = await fixture();
    await issueWalletOffer(b.kit.ctx, await tokenOf(b), 'google');
    const bSecond = await b.kit.pass({ holderEmail: 'd@example.test' });
    await tap(b, bSecond.id);
    await updatePass(
      jobCtxOf(b.kit),
      system,
      bSecond.id,
      { input: { memberName: 'B Edit' } },
      { scope: null },
    );
    await voidPass(jobCtxOf(b.kit), system, b.pass.id, {
      orgId: b.kit.org.id,
      mode: 'live',
      principal: 'session',
    });
    await handleWalletReissue(
      {
        kind: 'wallet.reissue',
        reissueId: 'b',
        orgId: b.kit.org.id,
        mode: 'live',
        provider: 'google',
      },
      jobCtxOf(b.kit),
    );
    const due = await listDueWalletOperations(a.kit.env.DB, a.kit.clock.now() + 60_000, 10);
    const order = due.map((o) => `${o.kind}:${o.orgId === a.kit.org.id ? 'A' : 'B'}`);
    // The void first, though it was queued last; B's update is not left behind A's reissue.
    expect(order[0]).toBe('revoke:B');
    expect(order).toContain('upsert:A');
    expect(order.indexOf('upsert:B')).toBeLessThan(order.lastIndexOf('upsert:A') + 1);
  });
});
