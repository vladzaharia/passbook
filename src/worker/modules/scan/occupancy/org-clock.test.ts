import { describe, expect, it } from 'vitest';
import { effectiveTimeZone, indexZones } from '../zones-tree.ts';
import { verdict } from './jobs.ts';
import type { DueRow } from './repo-reads.ts';
import { entryPlan, type OccZone } from './rules.ts';

const NY = 'America/New_York';
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
  updatedAt: 1,
  ...z,
});
const row = (entered: number, due: number): DueRow => ({
  pass_id: 'p',
  org_id: 'o',
  mode: 'live',
  scope: 'zone:gym',
  entered_at: entered,
  last_entry_at: entered,
  last_scan_id: 's',
  due_at: due,
  template_id: 't',
});

describe('zone clock order', () => {
  const zones = [
    zone('rooted', { timeZone: 'Asia/Tokyo' }),
    zone('under', { parentId: 'rooted' }),
    zone('bare'),
    zone('below', { parentId: 'bare' }),
  ];
  const index = indexZones(zones);

  it('is the root zone, then the org, then none', () => {
    expect(effectiveTimeZone(index, 'under', NY)).toBe('Asia/Tokyo');
    expect(effectiveTimeZone(index, 'rooted', NY)).toBe('Asia/Tokyo');
    expect(effectiveTimeZone(index, 'below', NY)).toBe(NY);
    expect(effectiveTimeZone(index, 'bare', NY)).toBe(NY);
    expect(effectiveTimeZone(index, 'bare', null)).toBeNull();
    expect(effectiveTimeZone(index, 'bare')).toBeNull();
  });
});

describe('a root zone clearing at the org midnight', () => {
  const gym = zone('gym', { clearAt: '00:00' });

  it('skips Clear at with no zone or org clock', () => {
    expect(entryPlan([gym], 'gym', Date.UTC(2026, 2, 7, 12), null)?.dueAt).toBeNull();
  });

  it('uses the org clock when the root has none, across the spring change', () => {
    // 2026-03-08: New York springs forward at 02:00, so that local day is 23 hours long.
    const before = Date.UTC(2026, 2, 7, 23, 0); // Mar 7 18:00 EST
    expect(entryPlan([gym], 'gym', before, NY)?.dueAt).toBe(Date.UTC(2026, 2, 8, 5, 0));
    const during = Date.UTC(2026, 2, 8, 16, 0); // Mar 8 12:00 EDT
    expect(entryPlan([gym], 'gym', during, NY)?.dueAt).toBe(Date.UTC(2026, 2, 9, 4, 0));
  });

  it('and across the autumn change', () => {
    // 2026-11-01: New York falls back at 02:00, so that local day is 25 hours long.
    const during = Date.UTC(2026, 10, 1, 16, 0); // Nov 1 11:00 EST
    expect(entryPlan([gym], 'gym', during, NY)?.dueAt).toBe(Date.UTC(2026, 10, 2, 5, 0));
    const before = Date.UTC(2026, 10, 1, 3, 0); // Oct 31 23:00 EDT
    expect(entryPlan([gym], 'gym', before, NY)?.dueAt).toBe(Date.UTC(2026, 10, 1, 4, 0));
  });

  it('prefers the root zone over the org', () => {
    const own = zone('gym', { clearAt: '00:00', timeZone: 'UTC' });
    const at = Date.UTC(2026, 2, 7, 23, 0);
    expect(entryPlan([own], 'gym', at, NY)?.dueAt).toBe(Date.UTC(2026, 2, 8, 0, 0));
  });

  it('lets the cron clear at the org midnight and re-arm before it', () => {
    const entered = Date.UTC(2026, 2, 8, 16, 0);
    const midnight = Date.UTC(2026, 2, 9, 4, 0);
    expect(verdict([gym], row(entered, midnight), midnight - 1, NY)).toEqual({ rearm: midnight });
    expect(verdict([gym], row(entered, midnight), midnight, NY)).toEqual({ exit: 'clear' });
  });
});
