import { describe, expect, it, vi } from 'vitest';
import type { ClockPort } from '../machine/ports.ts';
import type { ScanOutcome } from '../machine/types.ts';
import { createOfflineController, type OfflineEmit } from './controller.ts';
import { decide } from './decide.ts';
import { rosterHash } from './hash.ts';
import { createQueueStore, pendingOf, type QueueRow } from './queue-store.ts';
import { createRosterStore, type RosterEntry, type RosterMeta } from './roster.ts';
import { syncQueue } from './sync.ts';
import { createMemoryKeyValue } from './wipe.ts';

const NOW = 1_800_000_000_000;
const LIVE = { asOf: NOW - 60_000, validUntil: NOW + 86_400_000, sig: 'sig', fullAt: NOW - 60_000 };

const base = { unverified: false, listAt: NOW - 60_000, counts: null, now: NOW } as const;

describe('decide', () => {
  it('queues a listed, active pass that is not in', () => {
    const d = decide({ ...base, mode: 'list', entry: { status: 'active', state: null } });
    expect(d).toMatchObject({
      door: 'listed',
      markIn: true,
      outcome: { kind: 'queued', reason: 'saved_offline' },
    });
  });

  it('answers a pass already in as a heads-up and records the repeat', () => {
    const d = decide({ ...base, mode: 'list', entry: { status: 'active', state: 'in' } });
    expect(d).toMatchObject({
      door: 'refused',
      outcome: { kind: 'heads_up', reason: 'already_done' },
    });
  });

  it('refuses voided, removed and unlisted codes, and records each', () => {
    const reasons = (entry: RosterEntry | null) =>
      decide({ ...base, mode: 'list', entry }).outcome.reason;
    expect(reasons({ status: 'voided', state: null })).toBe('voided');
    expect(reasons({ status: 'removed', state: null })).toBe('removed');
    expect(reasons(null)).toBe('not_listed');
    expect(decide({ ...base, mode: 'list', entry: null }).door).toBe('refused');
  });

  it('says No connection, and queues nothing, with no list or an expired one', () => {
    const d = decide({ ...base, mode: 'list', entry: null, listAt: null });
    expect(d).toMatchObject({ door: null, outcome: { kind: 'system', reason: 'network' } });
  });

  it('Staff decide asks first, then queues an unverified entry', () => {
    const ask = decide({ ...base, mode: 'decide', entry: null });
    expect(ask).toMatchObject({
      door: null,
      outcome: { kind: 'heads_up', reason: 'offline_decide' },
    });
    expect(ask.outcome.action?.label).toBe('Let in');
    const yes = decide({ ...base, mode: 'decide', entry: null, unverified: true });
    expect(yes).toMatchObject({ door: 'unverified', outcome: { kind: 'queued' } });
  });
});

describe('roster store', () => {
  const page = (
    entries: { h: string; status: 'active' | 'voided'; state: 'in' | null }[],
    over = {},
  ) => ({
    entries,
    cursor: null,
    asOf: NOW,
    validUntil: NOW + 86_400_000,
    sig: 'sig',
    ...over,
  });

  it('replaces the list on a full download, and tops it up on a delta', async () => {
    const rows = createMemoryKeyValue<RosterEntry>();
    const meta = createMemoryKeyValue<RosterMeta>();
    const store = createRosterStore(rows, meta);
    const api = {
      roster: vi.fn(async (_cursor?: string, _since?: number) =>
        page([{ h: 'a', status: 'active', state: null }]),
      ),
    };
    await store.refresh(api, NOW);
    expect(await store.find(['a'])).toEqual({ status: 'active', state: null });
    expect(api.roster).toHaveBeenLastCalledWith(undefined, undefined);

    api.roster.mockResolvedValueOnce(page([{ h: 'b', status: 'voided', state: null }]));
    await store.refresh(api, NOW + 60_000);
    expect(api.roster.mock.calls.at(-1)?.[1]).toBeGreaterThan(0);
    expect(await store.find(['a'])).not.toBeNull();
    expect(await store.find(['b'])).toEqual({ status: 'voided', state: null });
  });

  it('keeps the old list when a download fails part way', async () => {
    const rows = createMemoryKeyValue<RosterEntry>();
    const store = createRosterStore(rows, createMemoryKeyValue<RosterMeta>());
    await store.refresh(
      { roster: async () => page([{ h: 'a', status: 'active', state: null }]) },
      NOW,
    );
    const broken = vi
      .fn()
      .mockResolvedValueOnce(page([{ h: 'z', status: 'active', state: null }], { cursor: 'next' }))
      .mockRejectedValueOnce(new Error('offline'));
    await expect(store.refresh({ roster: broken }, NOW + 11 * 60_000)).rejects.toThrow('offline');
    expect(await store.find(['a'])).not.toBeNull();
    expect(await store.find(['z'])).toBeNull();
  });
});

const row = (key: string, clientTs: number, door: QueueRow['door'] = 'listed'): QueueRow => ({
  key,
  scannerId: 's1',
  code: `code-${key}`,
  method: 'camera',
  clientTs,
  door,
});

describe('queue and sync', () => {
  it('lists oldest first, and counts saved check-ins, not recorded refusals', async () => {
    const queue = createQueueStore(createMemoryKeyValue<QueueRow>());
    await queue.add(row('b', 20));
    await queue.add(row('a', 10));
    await queue.add(row('r', 5, 'refused'));
    const all = await queue.all();
    expect(all.map((r) => r.key)).toEqual(['r', 'a', 'b']);
    expect(pendingOf(all)).toEqual({ pending: 2, oldestAt: 10 });
  });

  it('sends in batches of 50, echoes the roster window and clears only answered keys', async () => {
    const queue = createQueueStore(createMemoryKeyValue<QueueRow>());
    for (let i = 0; i < 120; i++) await queue.add(row(`k${String(i).padStart(3, '0')}`, i));
    const sent: string[][] = [];
    const api = {
      batch: vi.fn(async (body: { items: { idempotencyKey: string }[]; roster?: unknown }) => {
        sent.push(body.items.map((i) => i.idempotencyKey));
        // The server answers all but one key and flags one conflict.
        const answered = body.items.filter((i) => i.idempotencyKey !== 'k060');
        return {
          items: answered.map((i) => ({
            idempotencyKey: i.idempotencyKey,
            outcome: {} as never,
            conflict: i.idempotencyKey === 'k001',
          })),
        };
      }),
    };
    const result = await syncQueue(api, queue, LIVE);
    expect(sent.map((s) => s.length)).toEqual([50, 50, 20]);
    expect(api.batch.mock.calls[0]?.[0].roster).toEqual({
      asOf: LIVE.asOf,
      validUntil: LIVE.validUntil,
      sig: 'sig',
    });
    expect(result).toEqual({ done: 119, conflicts: 1 });
    expect((await queue.all()).map((r) => r.key)).toEqual(['k060']);
  });

  it('a failed request leaves its rows for the next pass', async () => {
    const queue = createQueueStore(createMemoryKeyValue<QueueRow>());
    await queue.add(row('a', 1));
    const api = { batch: vi.fn().mockRejectedValue(new Error('no network')) };
    await expect(syncQueue(api, queue, null)).rejects.toThrow();
    expect(await queue.all()).toHaveLength(1);
  });
});

function harness(
  mode: 'list' | 'decide',
  rosterEntries: { h: string; status: 'active' | 'voided'; state: 'in' | null }[],
) {
  const queueKv = createMemoryKeyValue<QueueRow>();
  const rosterKv = createMemoryKeyValue<RosterEntry>();
  const metaKv = createMemoryKeyValue<unknown>();
  const timers: (() => void)[] = [];
  const clock: ClockPort = {
    now: () => NOW,
    setTimeout: (fn) => timers.push(fn),
    clearTimeout: () => undefined,
  };
  const outcomes: [string, ScanOutcome][] = [];
  const queues: { pending: number; conflicts: number }[] = [];
  const emit: OfflineEmit = {
    outcome: (k, o) => outcomes.push([k, o]),
    queue: (q) => queues.push(q),
    status: () => undefined,
  };
  let online = false;
  const api = {
    roster: vi.fn(async () => ({
      entries: rosterEntries,
      cursor: null,
      asOf: NOW - 1000,
      validUntil: NOW + 86_400_000,
      sig: 'sig',
    })),
    batch: vi.fn(async (body: { items: { idempotencyKey: string }[] }) => ({
      items: body.items.map((i) => ({
        idempotencyKey: i.idempotencyKey,
        outcome: {} as never,
        conflict: false,
      })),
    })),
  };
  const make = () =>
    createOfflineController({
      mode,
      scannerId: 's1',
      api,
      queue: createQueueStore(queueKv),
      roster: createRosterStore(rosterKv, metaKv as never),
      meta: metaKv as never,
      clock,
      online: () => online,
      counts: () => null,
      emit,
    });
  return { make, api, outcomes, queues, queueKv, setOnline: (v: boolean) => (online = v) };
}

const input = (code: string) =>
  ({ id: 'i', at: NOW, sig: `c:${code}`, method: 'camera', code }) as never;

describe('controller', () => {
  it('decides a listed code offline, queues it, and survives a reload', async () => {
    const h = await rosterHash('TICKET-0001');
    const t = harness('list', [{ h, status: 'active', state: null }]);
    const first = t.make();
    t.setOnline(true);
    await first.start();
    t.setOnline(false);
    await first.decide('k1', input('TICKET-0001'), false);
    expect(t.outcomes.at(-1)?.[1]).toMatchObject({ kind: 'queued' });
    // The same code again is a repeat, not a second entry.
    await first.decide('k2', input('TICKET-0001'), false);
    expect(t.outcomes.at(-1)?.[1]).toMatchObject({ kind: 'heads_up', reason: 'already_done' });
    first.dispose();

    const reloaded = t.make();
    await reloaded.start();
    expect(t.queues.at(-1)?.pending).toBe(1);
    expect([...(await createQueueStore(t.queueKv).all())].map((r) => r.door)).toEqual([
      'listed',
      'refused',
    ]);
  });

  it('syncs the queue when the connection returns and counts conflicts', async () => {
    const h = await rosterHash('TICKET-0002');
    const t = harness('list', [{ h, status: 'active', state: null }]);
    const c = t.make();
    t.setOnline(true);
    await c.start();
    t.setOnline(false);
    await c.decide('k1', input('TICKET-0002'), false);
    t.api.batch.mockImplementationOnce(async (body) => ({
      items: body.items.map((i) => ({
        idempotencyKey: i.idempotencyKey,
        outcome: {} as never,
        conflict: true,
      })),
    }));
    t.setOnline(true);
    c.kick();
    await vi.waitFor(() => expect(t.queues.at(-1)).toMatchObject({ pending: 0, conflicts: 1 }));
  });

  it('with no list yet, a read says No connection and queues nothing', async () => {
    const t = harness('list', []);
    const c = t.make();
    await c.decide('k1', input('X'), false);
    expect(t.outcomes.at(-1)?.[1]).toMatchObject({ kind: 'system', reason: 'network' });
    expect(await createQueueStore(t.queueKv).all()).toEqual([]);
  });

  it('a read with no code, or a Staff decide without the tap, is never queued unverified', async () => {
    const t = harness('decide', []);
    const c = t.make();
    await c.decide('k1', input('X'), false);
    expect(t.outcomes.at(-1)?.[1]).toMatchObject({ kind: 'heads_up', reason: 'offline_decide' });
    await c.decide(
      'k2',
      { id: 'i', at: NOW, sig: 'p:1', method: 'manual', passId: 'p1' } as never,
      true,
    );
    expect(t.outcomes.at(-1)?.[1]).toMatchObject({ kind: 'system', reason: 'network' });
    expect(await createQueueStore(t.queueKv).all()).toEqual([]);
    await c.decide('k3', input('X'), true);
    expect((await createQueueStore(t.queueKv).all()).map((r) => r.door)).toEqual(['unverified']);
  });
});
