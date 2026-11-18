/** Access and occupancy outcomes for tests and the visual gallery. */
import { FIXTURE_NOW, fixtureCounts, fixtureOutcome } from './fixture-data.test-support.ts';
import type { ScanOutcome } from './types.ts';

export const GYM = {
  kind: 'zone' as const,
  id: '01900000-0000-7000-8000-0000000000b1',
  name: 'Gym',
};
const ACCESS_ACTION = { id: 'access', label: 'Access', kind: 'check_in' as const };
export const SINCE = FIXTURE_NOW - 40_000;

export const accessInfo = (over: Partial<NonNullable<ScanOutcome['access']>> = {}) => ({
  plan: { id: 'gold', label: 'Gold', kind: 'always' as const },
  zone: { id: GYM.id, name: 'Gym' },
  closesAt: null,
  nextOpenAt: null,
  visits: null,
  visit: true,
  timeZone: 'UTC',
  ...over,
});

export const occupancyInfo = (over: Partial<NonNullable<ScanOutcome['occupancy']>> = {}) => ({
  place: GYM,
  direction: 'in' as const,
  auto: false,
  state: 'in' as const,
  since: FIXTURE_NOW,
  via: 'Front desk',
  stayMs: null,
  inNow: 42,
  capacity: 60,
  turnaround: null,
  ...over,
});

const counts = fixtureCounts({ place: { name: 'Gym', inNow: 42, capacity: 60 } });

export const grant = (over: Partial<ScanOutcome> = {}) =>
  fixtureOutcome('ok', null, {
    action: ACCESS_ACTION,
    access: accessInfo({ closesAt: FIXTURE_NOW + 3 * 3_600_000 }),
    occupancy: occupancyInfo(),
    counts,
    ...over,
  });

export const exit = (over: Partial<ScanOutcome> = {}) =>
  grant({
    occupancy: occupancyInfo({ direction: 'out', state: 'out', stayMs: 92 * 60_000 }),
    access: accessInfo(),
    ...over,
  });

/** Already in, held by the turnaround guard: Tap out. */
export const heldIn = (over: Partial<ScanOutcome> = {}) =>
  fixtureOutcome('heads_up', 'still_inside', {
    action: ACCESS_ACTION,
    access: accessInfo(),
    occupancy: occupancyInfo({ since: SINCE, auto: true, turnaround: 'out' }),
    counts,
    ...over,
  });

/** Already out, held: Tap in. */
export const heldOut = (over: Partial<ScanOutcome> = {}) =>
  fixtureOutcome('heads_up', 'not_inside', {
    action: ACCESS_ACTION,
    access: accessInfo(),
    occupancy: occupancyInfo({ since: SINCE, state: 'out', auto: true, turnaround: 'in' }),
    counts,
    ...over,
  });

export const full = (over: Partial<ScanOutcome> = {}) =>
  fixtureOutcome('heads_up', 'capacity_full', {
    action: ACCESS_ACTION,
    access: accessInfo(),
    occupancy: occupancyInfo({ inNow: 60, capacity: 60, state: 'out', since: null }),
    counts,
    ...over,
  });
