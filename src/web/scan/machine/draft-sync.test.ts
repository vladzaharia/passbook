import { beforeEach, describe, expect, it, vi } from 'vitest';
import { draftHealth } from './draft-health.ts';
import { fixtureCard, fixtureInput, fixtureOutcome, states } from './fixtures.test-support.ts';
import { resetIds } from './reduce.test-support.ts';
import { fakeClock, fakeDeps, flush } from './store.test-support.ts';
import { createScanStore } from './store.ts';

beforeEach(() => {
  resetIds();
  draftHealth.reset();
});

type Action = ReturnType<typeof fixtureCard>['actions'][number];
const base = fixtureCard().actions[1] as Action;
const take: Action = {
  ...base,
  id: 'take_money',
  kind: 'take',
  available: true,
  lock: null,
  confirm: false,
  amount: { max: 100, presets: [10, 20], default: 12 },
};
const money: Record<string, unknown>[] = [
  {
    input: 'balance',
    label: 'Balance',
    before: 42.5,
    after: null,
    goal: null,
    format: 'currency',
    currency: 'USD',
  },
];
const card = (over = {}) => fixtureCard({ actions: [take], values: money as never, ...over });

interface Deferred {
  body: { ref: string; actionId: string; amount: number };
  at: number;
  settle: (screens?: number) => void;
  fail: () => void;
}

/** A draft port whose calls the test settles itself. */
function port(clock: ReturnType<typeof fakeClock>, manual = false, slowClear = false) {
  const puts: Deferred[] = [];
  const clears: { ref: string; keep: boolean }[] = [];
  const clearSettles: (() => void)[] = [];
  return {
    puts,
    clears,
    clearSettles,
    port: {
      put: vi.fn((body: Deferred['body']) => {
        return new Promise<{ screens: number }>((resolve, reject) => {
          const call = {
            body,
            at: clock.now(),
            settle: (screens = 1) => resolve({ screens }),
            fail: () => reject(Object.assign(new Error('no'), { code: 'SCAN_DRAFT_STALE' })),
          };
          puts.push(call);
          if (!manual) call.settle();
        });
      }),
      clear: vi.fn((ref: string, keep: boolean) => {
        clears.push({ ref, keep });
        if (!slowClear) return Promise.resolve({ screens: 1 });
        return new Promise<{ screens: number }>((resolve) =>
          clearSettles.push(() => resolve({ screens: 1 })),
        );
      }),
    },
  };
}

async function desk(
  opts: { manual?: boolean; slowClear?: boolean; passId?: string; outcome?: object } = {},
) {
  const clock = fakeClock();
  const fake = fakeDeps(clock);
  const draft = port(clock, opts.manual, opts.slowClear);
  fake.api.resolve.mockResolvedValue(fixtureOutcome('ready', null, { card: card(opts.outcome) }));
  const store = createScanStore(
    { ...fake.deps, draft: draft.port },
    { ...states.ready(), posture: 'desk' },
  );
  store.dispatch({
    type: 'read',
    input: fixtureInput({
      code: 'AAAA1111',
      sig: 'c:AAAA1111',
      ...(opts.passId ? { passId: opts.passId } : {}),
    }),
  });
  await flush();
  const sent = (fake.api.resolve.mock.calls[0]?.[0] ?? {}) as { idempotencyKey: string };
  return { clock, store, api: fake.api, ...draft, key: sent.idempotencyKey };
}

const open = (d: Awaited<ReturnType<typeof desk>>) =>
  d.store.dispatch({ type: 'pick', actionId: take.id });

describe('draft sync', () => {
  it('sends the resolve key and the amount once the typing settles', async () => {
    const d = await desk();
    open(d);
    d.clock.advance(100);
    d.store.dispatch({ type: 'amount', value: 20 });
    d.clock.advance(249);
    expect(d.puts).toHaveLength(0);
    d.clock.advance(1);
    expect(d.puts.map((p) => p.body)).toEqual([{ ref: d.key, actionId: take.id, amount: 20 }]);
  });

  it('collapses a burst of typing into one draft with the last amount', async () => {
    const d = await desk();
    open(d);
    for (let v = 1; v <= 60; v++) {
      d.store.dispatch({ type: 'amount', value: v });
      d.clock.advance(40);
    }
    d.clock.advance(300);
    await flush();
    expect(d.puts.map((p) => p.body.amount)).toEqual([60]);
  });

  it('sends slower typing at least 250 ms apart, so never more than four a second', async () => {
    const d = await desk();
    open(d);
    for (let v = 1; v <= 30; v++) {
      d.store.dispatch({ type: 'amount', value: v });
      d.clock.advance(255);
      await flush();
    }
    const times = d.puts.map((p) => p.at);
    expect(times.length).toBeGreaterThan(20);
    for (let i = 1; i < times.length; i++)
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(250);
  });

  it('keeps one call on the wire and sends only the latest when it lands', async () => {
    const d = await desk({ manual: true });
    open(d);
    d.clock.advance(250);
    expect(d.puts).toHaveLength(1);
    for (const v of [31, 32, 33]) {
      d.store.dispatch({ type: 'amount', value: v });
      d.clock.advance(300);
    }
    expect(d.puts).toHaveLength(1);
    d.puts[0]?.settle();
    await flush();
    expect(d.puts).toHaveLength(2);
    expect(d.puts[1]?.body.amount).toBe(33);
  });

  it('closing the picker on the same read clears only the draft', async () => {
    const d = await desk();
    open(d);
    d.clock.advance(300);
    await flush();
    d.store.dispatch({ type: 'amount', value: 30 });
    d.store.dispatch({ type: 'cancel' });
    d.clock.advance(1000);
    await flush();
    expect(d.puts).toHaveLength(1);
    expect(d.clears).toEqual([{ ref: d.key, keep: true }]);
    // A re-pick draws again.
    open(d);
    d.clock.advance(300);
    expect(d.puts).toHaveLength(2);
  });

  it('leaving the read clears the draft and the ready card', async () => {
    const d = await desk();
    open(d);
    d.clock.advance(300);
    await flush();
    d.store.dispatch({ type: 'cancel' });
    d.store.dispatch({ type: 'dismiss' });
    expect(d.clears.at(-1)).toEqual({ ref: d.key, keep: false });
  });

  it('leaving a read that never drafted still clears the ready card', async () => {
    const d = await desk();
    expect(d.clears).toEqual([]);
    d.store.dispatch({ type: 'dismiss' });
    expect(d.clears).toEqual([{ ref: d.key, keep: false }]);
  });

  it('an empty or invalid field clears only the draft', async () => {
    const d = await desk();
    open(d);
    d.clock.advance(300);
    d.store.dispatch({ type: 'amount', value: null });
    expect(d.clears).toEqual([{ ref: d.key, keep: true }]);
    d.clock.advance(1000);
    expect(d.puts).toHaveLength(1);
  });

  it('a Confirm that ends ok forgets the draft; a late one never goes out', async () => {
    const d = await desk();
    open(d);
    d.store.dispatch({ type: 'amount', value: 30 });
    d.store.dispatch({ type: 'confirm' });
    d.clock.advance(1000);
    await flush();
    expect(d.store.getSnapshot().state.loop).toMatchObject({
      s: 'verdict',
      outcome: { kind: 'ok' },
    });
    expect(d.puts).toHaveLength(0);
    expect(d.clears).toEqual([]);
  });

  it('a Confirm that does not end ok clears the draft and the ready card', async () => {
    const d = await desk();
    d.api.act.mockResolvedValue(fixtureOutcome('refused', 'expired'));
    open(d);
    d.clock.advance(300);
    await flush();
    d.store.dispatch({ type: 'amount', value: 30 });
    d.store.dispatch({ type: 'confirm' });
    await flush();
    expect(d.clears).toEqual([{ ref: d.key, keep: false }]);
  });

  it('sends the open draft again every 15 s', async () => {
    const d = await desk();
    open(d);
    d.clock.advance(300);
    await flush();
    expect(d.puts).toHaveLength(1);
    d.clock.advance(15_000);
    await flush();
    expect(d.puts).toHaveLength(2);
    expect(d.puts[1]?.body).toEqual(d.puts[0]?.body);
  });

  it('sends a clear again when it passed a draft still on the wire', async () => {
    const d = await desk({ manual: true });
    open(d);
    d.clock.advance(300);
    d.store.dispatch({ type: 'cancel' });
    expect(d.clears).toHaveLength(1);
    d.puts[0]?.settle();
    await flush();
    expect(d.clears).toHaveLength(2);
  });

  it('sends a re-pick that waited behind a clear once the clear has gone', async () => {
    const d = await desk({ manual: true });
    open(d);
    d.clock.advance(300);
    d.store.dispatch({ type: 'cancel' });
    open(d);
    d.clock.advance(300);
    expect(d.puts).toHaveLength(1);
    d.puts[0]?.settle();
    await flush();
    await flush();
    expect(d.clears).toHaveLength(2);
    expect(d.puts).toHaveLength(2);
  });

  it('keeps the call on the wire until the trailing clear settles, so a new draft cannot overtake it', async () => {
    const d = await desk({ manual: true, slowClear: true });
    open(d);
    d.clock.advance(300);
    d.store.dispatch({ type: 'cancel' });
    open(d);
    d.clock.advance(300);
    d.puts[0]?.settle();
    await flush();
    expect(d.clears).toHaveLength(2); // the immediate clear, then the trailing one
    expect(d.puts).toHaveLength(1);
    d.clearSettles[1]?.();
    await flush();
    expect(d.puts).toHaveLength(2);
  });

  it('re-arms the 15 s resend when the call lands, and when the timer finds one on the wire', async () => {
    const d = await desk({ manual: true });
    open(d);
    d.clock.advance(300);
    d.clock.advance(15_000);
    expect(d.puts).toHaveLength(1);
    d.puts[0]?.settle();
    await flush();
    d.clock.advance(15_000);
    await flush();
    expect(d.puts).toHaveLength(2);
  });

  it('drafts only a single currency value with an amount to choose', async () => {
    const stamps = await desk({ outcome: { values: [{ ...money[0], format: 'number' }] } });
    open(stamps);
    stamps.clock.advance(1000);
    expect(stamps.puts).toHaveLength(0);
    const fixed = await desk({ outcome: { actions: [{ ...take, amount: { fixed: 5 } }] } });
    open(fixed);
    fixed.clock.advance(1000);
    expect(fixed.puts).toHaveLength(0);
    const two = await desk({ outcome: { values: [money[0], money[0]] } });
    open(two);
    two.clock.advance(1000);
    expect(two.puts).toHaveLength(0);
  });

  it('never drafts a lookup read, an offline read or a non-money action', async () => {
    const lookup = await desk({ passId: 'pass-1' });
    open(lookup);
    lookup.clock.advance(1000);
    expect(lookup.puts).toHaveLength(0);
    const offline = await desk();
    offline.store.dispatch({ type: 'online', online: false });
    open(offline);
    offline.clock.advance(1000);
    expect(offline.puts).toHaveLength(0);
    const set = await desk({ outcome: { actions: [{ ...take, kind: 'set' }] } });
    open(set);
    set.clock.advance(1000);
    expect(set.puts).toHaveLength(0);
  });

  it('counts a failed draft and shows nothing to staff', async () => {
    const d = await desk({ manual: true });
    open(d);
    d.clock.advance(300);
    d.puts[0]?.fail();
    await flush();
    expect(draftHealth.failures()).toBe(1);
    expect(draftHealth.onScreen()).toBe(false);
    expect(d.store.getSnapshot().state.loop.s).toBe('member');
  });

  it('says it is on screen only while the last draft reached a screen', async () => {
    const d = await desk({ manual: true });
    open(d);
    d.clock.advance(300);
    d.puts[0]?.settle(1);
    await flush();
    expect(draftHealth.onScreen()).toBe(true);
    d.store.dispatch({ type: 'amount', value: 40 });
    d.clock.advance(300);
    d.puts[1]?.settle(0);
    await flush();
    expect(draftHealth.onScreen()).toBe(false);
  });
});
