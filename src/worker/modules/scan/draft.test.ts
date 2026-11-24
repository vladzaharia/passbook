import { beforeAll, describe, expect, it, vi } from 'vitest';
import { first, run } from '../../platform/db.ts';
import {
  call,
  desk,
  drafts,
  flush,
  setupDraftFixture,
  state,
  wait,
} from './draft-test-fixtures.ts';
import { liveReadyId } from './live.ts';
import { kit } from './scan-hub-test-fixtures.ts';

beforeAll(setupDraftFixture);

describe('PUT /draft', () => {
  it('shows to pay and the balance after on the followed screen, never the monitor', async () => {
    const d = await desk();
    const { ref } = await d.read();
    const res = await d.draft(ref, 'pay', 12);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ screens: 1 });
    await wait();
    expect(drafts(d.seen)).toHaveLength(1);
    expect(drafts(d.seen)[0]).toMatchObject({
      draft: {
        customer: {
          screen: 'review',
          band: { headline: 'To pay', sub: 'Balance after: $30.50' },
          figure: '$12.00',
        },
      },
    });
    expect(drafts(d.watched)).toEqual([]);
    const top = await d.draft(ref, 'top', 20);
    expect(await top.json()).toEqual({ screens: 1 });
    await wait();
    expect(drafts(d.seen).at(-1)).toMatchObject({
      draft: {
        customer: { band: { headline: 'Adding', sub: 'Balance after: $62.50' }, figure: '$20.00' },
      },
    });
    d.close();
  });

  it('shows only the figure when the balance is short', async () => {
    const d = await desk(10);
    const { ref } = await d.read();
    expect(await (await d.draft(ref, 'pay', 12)).json()).toEqual({ screens: 1 });
    await wait();
    expect(drafts(d.seen)[0]).toMatchObject({
      draft: { customer: { band: { headline: 'To pay', sub: null }, figure: '$12.00' } },
    });
    d.close();
  });

  it('refuses what is not money to take or add, or an amount past the limit', async () => {
    const d = await desk();
    const { ref } = await d.read();
    for (const [action, amount] of [
      ['stamp', 1],
      ['fix', 5],
      ['in', 1],
      ['nope', 1],
      ['pay', 0],
      ['pay', 51],
      ['pay', 1.234],
    ] as const) {
      const res = await d.draft(ref, action, amount);
      expect(res.status, `${action} ${amount}`).toBe(422);
      expect(await res.json()).toMatchObject({ code: 'SCAN_DRAFT_INVALID' });
    }
    await wait();
    expect(drafts(d.seen)).toEqual([]);
    d.close();
  });

  it('is stale for a read that is over, one from another scanner, or one not presented', async () => {
    const d = await desk();
    const old = await d.read();
    kit.clock.advance(61_000);
    const res = await d.draft(old.ref, 'pay', 5);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'SCAN_DRAFT_STALE' });
    const fresh = await d.read();
    const other = await kit.scanner({
      templateIds: [state.money],
      settings: { roleWithoutSignIn: 'desk' },
    });
    expect((await d.draft(fresh.ref, 'pay', 5, other.headers)).status).toBe(409);
    const manual = await d.read(d.source.id, { passId: d.pass.id, method: 'manual' });
    expect((await d.draft(manual.ref, 'pay', 5)).status).toBe(409);
    expect(drafts(d.seen)).toEqual([]);
    d.close();
  });

  it('is stale once the pass is no longer current', async () => {
    const d = await desk();
    const { ref } = await d.read();
    await run(
      kit.env.DB,
      "UPDATE passes SET status='voided', lifecycle_generation=lifecycle_generation+1 WHERE id=?",
      [d.pass.id],
    );
    expect((await d.draft(ref, 'pay', 5)).status).toBe(409);
    expect(drafts(d.seen)).toEqual([]);
    d.close();
  });

  it('refuses a screen: only a paired scanner drafts', async () => {
    const d = await desk();
    const { ref } = await d.read();
    expect((await d.draft(ref, 'pay', 5, d.customer.headers)).status).toBe(403);
    expect((await d.draft(ref, 'pay', 5, d.watchedHeaders)).status).toBe(403);
    d.close();
  });

  it('never blocks the commit when the hub fails', async () => {
    const d = await desk();
    const { ref } = await d.read();
    const real = kit.env.SCAN_HUB.getByName.bind(kit.env.SCAN_HUB);
    const spy = vi.spyOn(kit.env.SCAN_HUB, 'getByName').mockImplementation((name: string) => {
      const stub = real(name);
      return {
        ringRow: (id: string, now?: number) => stub.ringRow(id, now),
        publish: (input: Parameters<typeof stub.publish>[0]) => stub.publish(input),
        draft: () => Promise.reject(new Error('hub down')),
        clearDraft: () => Promise.reject(new Error('hub down')),
      } as never;
    });
    try {
      const res = await d.draft(ref, 'pay', 12);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ screens: 0 });
      const committed = await d.act('pay', 12);
      expect(committed.status).toBe(200);
      expect(await committed.json()).toMatchObject({
        kind: 'ok',
        value: { before: 42.5, after: 30.5 },
      });
    } finally {
      spy.mockRestore();
    }
    d.close();
  });
});

describe('DELETE /draft', () => {
  it('clears the draft and the ready card on the followed screen only', async () => {
    const d = await desk();
    const { ref } = await d.read();
    const readyId = await liveReadyId(d.source.id, ref);
    await d.draft(ref, 'pay', 12);
    const res = await call('DELETE', d.source.headers, `/draft?ref=${ref}`);
    expect(await res.json()).toEqual({ screens: 1 });
    await wait();
    expect(drafts(d.seen).at(-1)).toEqual({
      draft: { ref: readyId, at: expect.any(Number), cancelled: true },
    });
    expect(drafts(d.watched)).toEqual([]);
    const other = await kit.scanner({
      templateIds: [state.money],
      settings: { roleWithoutSignIn: 'desk' },
    });
    expect(await (await call('DELETE', other.headers, `/draft?ref=${ref}`)).json()).toEqual({
      screens: 0,
    });
    d.close();
  });
});

describe('the receipt on a committed scan', () => {
  it('says what was paid and the balance after, and what was added', async () => {
    const d = await desk();
    expect((await d.act('pay', 12)).status).toBe(200);
    await flush();
    await wait();
    expect(JSON.stringify(d.seen.messages)).toContain('Paid $12.00');
    expect(JSON.stringify(d.seen.messages)).toContain('Balance $30.50');
    expect((await d.act('top', 20)).status).toBe(200);
    await flush();
    await wait();
    expect(JSON.stringify(d.seen.messages)).toContain('Added $20.00');
    expect(JSON.stringify(d.seen.messages)).toContain('Balance $50.50');
    const bands = d.seen.messages.flatMap((m) =>
      ((m.rows as { customer?: { band: { headline: string } } }[]) ?? []).map(
        (r) => r.customer?.band.headline,
      ),
    );
    expect(bands).toEqual(['Paid $12.00', 'Added $20.00']);
    expect(await first(kit.env.DB, 'SELECT 1 FROM passes WHERE id=?', [d.pass.id])).not.toBeNull();
    d.close();
  });

  it('says plus the stamps and how many of the goal for a count', async () => {
    const d = await desk();
    expect((await d.act('stamp')).status).toBe(200);
    await flush();
    await wait();
    expect(JSON.stringify(d.seen.messages)).toContain('+1 visit');
    d.close();
  });
});
