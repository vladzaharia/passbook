import { describe, expect, it } from 'vitest';
import {
  dueAt,
  type EntryPlan,
  entryPlan,
  entryReason,
  instantOf,
  nextClear,
  type OccZone,
  hardLimited,
  scanDirection,
  zonePlace,
} from './rules.ts';

const MIN = 60_000;
const zone = (id: string, z: Partial<OccZone> = {}): OccZone => ({
  id,
  parentId: null,
  name: id,
  sort: 0,
  timeZone: null,
  occupancy: 'track',
  capacity: null,
  maxStayMinutes: null,
  clearAt: null,
  archivedAt: null,
  updatedAt: 0,
  ...z,
});

const tree = [
  zone('gym', { occupancy: 'enforce', capacity: 60, maxStayMinutes: 720, timeZone: 'UTC' }),
  zone('pool', { parentId: 'gym', capacity: 25 }),
  zone('sauna', { parentId: 'pool', capacity: 8 }),
  zone('studio', { parentId: 'gym', occupancy: 'off' }),
];

describe('entry plans', () => {
  it('needs the nearest enforcing parent and implies the tracked zones between', () => {
    const plan = entryPlan(tree, 'sauna', 0, null) as EntryPlan;
    expect(plan).toMatchObject({ place: 'zone:sauna', parent: 'zone:gym', enforce: false });
    expect(plan.implied.map((p) => p.place)).toEqual(['zone:pool']);
    expect(entryPlan(tree, 'gym', 0, null)?.below).toEqual(['zone:pool', 'zone:sauna']);
    expect(entryPlan(tree, 'studio', 0, null)).toBeNull();
  });

  it('a parent waiver enters every tracked ancestor', () => {
    const plan = entryPlan(tree, 'sauna', 0, null, { parent: true }) as EntryPlan;
    expect(plan.parent).toBeNull();
    expect(plan.implied.map((p) => p.place)).toEqual(['zone:pool', 'zone:gym']);
    expect(plan.implied[1]?.dueAt).toBe(720 * MIN);
  });

  it('an archived or untracked zone is not a place', () => {
    expect(entryPlan([zone('x', { archivedAt: 1 })], 'x', 0, null)).toBeNull();
    expect(entryPlan([zone('x', { occupancy: 'off' })], 'x', 0, null)).toBeNull();
  });
});

describe('due times', () => {
  const ny = 'America/New_York';
  it('is the earlier of max stay and the next clear', () => {
    const since = Date.UTC(2026, 5, 1, 20, 0);
    expect(dueAt({ maxStayMinutes: 60, clearAt: null }, since, 'UTC')).toBe(since + 60 * MIN);
    expect(dueAt({ maxStayMinutes: 600, clearAt: '23:00' }, since, 'UTC')).toBe(
      Date.UTC(2026, 5, 1, 23, 0),
    );
    expect(dueAt({ maxStayMinutes: null, clearAt: '03:00' }, since, ny)).toBe(
      Date.UTC(2026, 5, 2, 7, 0),
    );
    // No clock: the clear is skipped, max stay still runs.
    expect(dueAt({ maxStayMinutes: null, clearAt: '03:00' }, since, null)).toBeNull();
  });

  it('a clear in the spring gap fires when the gap ends; the autumn hour at its first instance', () => {
    // 2026-03-08: 02:00 EST jumps to 03:00 EDT (07:00Z).
    expect(nextClear('02:30', Date.UTC(2026, 2, 8, 5, 0), ny)).toBe(Date.UTC(2026, 2, 8, 7, 0));
    // 2026-11-01: 01:30 happens at 05:30Z (EDT) and again at 06:30Z (EST).
    expect(nextClear('01:30', Date.UTC(2026, 10, 1, 4, 0), ny)).toBe(Date.UTC(2026, 10, 1, 5, 30));
    expect(instantOf(Date.UTC(2026, 0, 1, 9, 0), 'Asia/Kolkata')).toBe(Date.UTC(2026, 0, 1, 3, 30));
    // Lord Howe moves half an hour: 02:00 becomes 02:30 on 2026-10-04.
    expect(instantOf(Date.UTC(2026, 9, 4, 2, 15), 'Australia/Lord_Howe')).toBe(
      Date.UTC(2026, 9, 3, 15, 30),
    );
  });
});

describe('direction', () => {
  it('Auto infers from inside, holds a quick flip, and a pin skips the hold', () => {
    const base = { setting: 'both' as const, now: 10 * MIN };
    expect(scanDirection({ ...base, inside: true, lastChangeAt: 0 })).toEqual({
      direction: 'out',
      auto: true,
      turnaround: null,
    });
    expect(scanDirection({ ...base, inside: true, lastChangeAt: 9 * MIN }).turnaround).toBe('out');
    expect(
      scanDirection({ ...base, requested: 'out', inside: true, lastChangeAt: 9 * MIN }),
    ).toMatchObject({ direction: 'out', auto: false, turnaround: null });
    expect(
      scanDirection({ ...base, setting: 'in', inside: true, lastChangeAt: null }).direction,
    ).toBe('in');
  });
});

describe('a lost entry names one reason, in step 15 order', () => {
  const plan = entryPlan(tree, 'sauna', 0, null) as EntryPlan;
  const row = (scope: string, state = 'in', due_at: number | null = null) => ({
    scope,
    state,
    due_at,
    last_entry_at: 0,
  });
  const why = (rows: ReturnType<typeof row>[], counts: [string, number][], o = {}) =>
    entryReason(plan, { rows, counts: new Map(counts) }, 5 * MIN, o)?.reason ?? null;

  it('parent, inside, wait, limit, capacity', () => {
    expect(why([], [])).toBe('not_inside');
    expect(why([row('zone:gym', 'in', MIN)], [])).toBe('not_inside');
    const inGym = row('zone:gym');
    const full: [string, number][] = [[zonePlace('pool'), 25]];
    const recent = { scope: 'zone:sauna', state: 'out', due_at: null, last_entry_at: 4 * MIN };
    expect(why([inGym, recent], full, { waitMs: 10 * MIN, limitOk: false })).toBe('cooldown');
    expect(why([inGym], full, { limitOk: false })).toBe('guest_visits_used');
    expect(why([inGym], full)).toBe('capacity_full');
    expect(why([inGym, row('zone:pool')], full)).toBeNull();
    expect(why([inGym], full, { waivers: { cap: true } })).toBeNull();
    const gym = entryPlan(tree, 'gym', 0, null) as EntryPlan;
    expect(entryReason(gym, { rows: [inGym], counts: new Map() }, 0)?.reason).toBe('still_inside');
  });
});

describe('hardLimited', () => {
  const zones = [
    zone('site', { hardLimit: true }),
    zone('room', { parentId: 'site' }),
    zone('annex'),
  ];
  it('is true for the zone and for every zone under one that has a Hard limit', () => {
    expect(hardLimited(zones, 'site')).toBe(true);
    expect(hardLimited(zones, 'room')).toBe(true);
    expect(hardLimited(zones, 'annex')).toBe(false);
  });
});
