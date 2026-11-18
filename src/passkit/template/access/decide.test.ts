import { describe, expect, it } from 'vitest';
import type { AccessManifest, AccessPlan } from '../../types.ts';
import { type DecideInput, decide, type ZoneNode } from './decide.ts';
import { accessScope, hoursText, zonesText } from './scope.ts';

const z = (s: string) => Date.parse(s);
const zone = (
  id: string,
  key: string,
  parentId: string | null = null,
  extra: Partial<ZoneNode> = {},
): ZoneNode => ({
  id,
  key,
  name: key[0]?.toUpperCase() + key.slice(1),
  parentId,
  timeZone: null,
  archived: false,
  ...extra,
});
const ZONES = [
  zone('hill', 'capitol-hill', null, { timeZone: 'America/Los_Angeles' }),
  zone('main', 'main-floor', 'hill'),
  zone('studio', 'studio', 'main'),
  zone('pool', 'pool', 'hill'),
  zone('qa', 'queen-anne', null, { timeZone: 'America/New_York' }),
];
const PLANS: AccessPlan[] = [
  { id: 'gold', label: '24/7 Gold', kind: 'always', zones: [{ zone: '*' }] },
  { id: 'hill_all', label: 'Hill', kind: 'always', zones: [{ zone: 'capitol-hill' }] },
  {
    id: 'offpeak',
    label: 'Off-peak',
    kind: 'timed',
    hours: { mon: ['06:00-22:00'], tue: ['06:00-22:00'] },
    zones: [{ zone: 'capitol-hill' }, { zone: 'pool', hours: { mon: ['06:00-10:00'] } }],
  },
  {
    id: 'night',
    label: 'Night',
    kind: 'timed',
    hours: { fri: ['22:00-02:00'] },
    zones: [{ zone: '*' }],
  },
  {
    id: 'guest',
    label: 'Guest day',
    kind: 'guest',
    visits: 2,
    zones: [{ zone: '*' }],
  },
  { id: 'three', label: 'Three days', kind: 'guest', days: 3, zones: [{ zone: '*' }] },
  { id: 'home', label: 'Home club', kind: 'always', zones: [{ zone: { input: 'homeClub' } }] },
  { id: 'nope', label: 'Nowhere', kind: 'always', zones: [{ zone: 'ghost' }] },
];
const ACCESS: AccessManifest = {
  input: {
    plan: 'plan',
    zones: 'addOns',
    from: 'from',
    until: 'until',
    visits: 'visits',
    sponsor: 'sponsor',
  },
  plans: PLANS,
  suspend: { input: 'status', equals: ['Suspended'] },
};
const MON_11 = z('2026-11-16T19:00:00Z'); // 11:00 in Los Angeles
const make = (inputs: Record<string, unknown>, over: Partial<DecideInput> = {}): DecideInput => ({
  access: ACCESS,
  inputs,
  createdAt: z('2026-11-01T00:00:00Z'),
  now: MON_11,
  zones: ZONES,
  scannerZoneIds: [],
  timeZone: 'UTC',
  ...over,
});
const run = (inputs: Record<string, unknown>, over: Partial<DecideInput> = {}) =>
  decide(make(inputs, over));

describe('every refusal, in order', () => {
  it('grants an always plan with no closing time and no zone when the scanner has none', () => {
    const d = run({ plan: 'gold' });
    expect(d).toMatchObject({ allowed: true, reason: null });
    expect(d.access).toMatchObject({
      zone: null,
      closesAt: null,
      nextOpenAt: null,
      plan: { id: 'gold', kind: 'always' },
    });
  });
  it('suspended comes first, even for a guest outside hours', () => {
    const d = run({ plan: 'guest', status: 'Suspended', until: '2026-01-01T00:00:00Z' });
    expect(d.reason).toBe('suspended');
    expect(run({ plan: 'gold', status: 'Active' }).allowed).toBe(true);
  });
  it('not_yet_valid before the start, with the time', () => {
    const d = run({ plan: 'gold', from: '2026-12-01T08:00:00Z' });
    expect(d).toMatchObject({ reason: 'not_yet_valid', at: z('2026-12-01T08:00:00Z') });
    expect(run({ plan: 'gold', from: '2026-11-16T19:00:00Z' }).allowed).toBe(true);
  });
  it('guest_expired at the end, exclusive', () => {
    const until = '2026-11-16T19:00:00Z';
    expect(run({ plan: 'guest', until })).toMatchObject({ reason: 'guest_expired', at: MON_11 });
    expect(run({ plan: 'guest', until: '2026-11-16T19:00:01Z' }).allowed).toBe(true);
  });
  it('zone_not_included when the scanner zone is not granted', () => {
    const d = run({ plan: 'hill_all' }, { scannerZoneIds: ['qa'] });
    expect(d).toMatchObject({ reason: 'zone_not_included', access: { zone: { id: 'qa' } } });
    expect(run({ plan: 'hill_all' }, { scannerZoneIds: [] }).allowed).toBe(true);
  });
  it('outside_hours with the next opening', () => {
    const d = run({ plan: 'night' }, { scannerZoneIds: ['pool'] });
    expect(d).toMatchObject({
      reason: 'outside_hours',
      access: { nextOpenAt: z('2026-11-21T06:00:00Z'), zone: { id: 'pool' } },
    });
  });
  it('outside_hours looks a week ahead', () => {
    const d = run({ plan: 'night' }, { now: z('2026-11-21T10:00:00Z') });
    expect(d).toMatchObject({
      reason: 'outside_hours',
      access: { nextOpenAt: z('2026-11-27T22:00:00Z') },
    });
  });
  it('an unknown plan refuses zone_not_included and says so', () => {
    for (const plan of ['gone', undefined]) {
      const d = run({ plan });
      expect(d).toMatchObject({ allowed: false, reason: 'zone_not_included', planUnknown: true });
    }
  });
  it('a plan whose zones never match refuses zone_not_included', () => {
    expect(run({ plan: 'nope' }).reason).toBe('zone_not_included');
  });
});

describe('zones and grants', () => {
  it('a parent grant opens its descendants, not its siblings', () => {
    const grants = (id: string) => run({ plan: 'hill_all' }, { scannerZoneIds: [id] }).allowed;
    expect(grants('hill')).toBe(true);
    expect(grants('main')).toBe(true);
    expect(grants('studio')).toBe(true);
    expect(grants('pool')).toBe(true);
    expect(grants('qa')).toBe(false);
    const poolOnly: AccessManifest = {
      ...ACCESS,
      plans: [{ id: 'p', label: 'P', kind: 'always', zones: [{ zone: 'pool' }] }],
    };
    expect(run({ plan: 'p' }, { access: poolOnly, scannerZoneIds: ['studio'] }).reason).toBe(
      'zone_not_included',
    );
  });
  it('the nearest grant decides the hours: the pool narrows Off-peak, the studio does not', () => {
    const at = (t: string, id: string) =>
      run({ plan: 'offpeak' }, { now: z(t), scannerZoneIds: [id] });
    expect(at('2026-11-16T19:00:00Z', 'studio').allowed).toBe(true);
    expect(at('2026-11-16T19:00:00Z', 'pool').reason).toBe('outside_hours');
    expect(at('2026-11-16T15:00:00Z', 'pool').allowed).toBe(true);
  });
  it('hours intersect, never union', () => {
    const d = run(
      { plan: 'offpeak' },
      { now: z('2026-11-17T15:00:00Z'), scannerZoneIds: ['pool'] },
    );
    expect(d.reason).toBe('outside_hours');
    expect(d.access.nextOpenAt).toBe(z('2026-11-23T14:00:00Z'));
  });
  it('an add-on follows the plan hours only', () => {
    const at = { now: z('2026-11-16T19:00:00Z'), scannerZoneIds: ['pool'] };
    const plan = { ...ACCESS.plans[2] } as AccessPlan;
    const access: AccessManifest = { ...ACCESS, plans: [{ ...plan, zones: [{ zone: 'studio' }] }] };
    expect(run({ plan: 'offpeak' }, { access, ...at }).reason).toBe('zone_not_included');
    expect(run({ plan: 'offpeak', addOns: ['pool'] }, { access, ...at }).allowed).toBe(true);
    expect(run({ plan: 'offpeak', addOns: 'pool' }, { access, ...at }).allowed).toBe(true);
  });
  it('a grant from an input holds the zone key', () => {
    expect(run({ plan: 'home', homeClub: 'queen-anne' }, { scannerZoneIds: ['qa'] }).allowed).toBe(
      true,
    );
    expect(run({ plan: 'home', homeClub: 'queen-anne' }, { scannerZoneIds: ['pool'] }).reason).toBe(
      'zone_not_included',
    );
    expect(run({ plan: 'home' }, { scannerZoneIds: ['pool'] }).reason).toBe('zone_not_included');
  });
  it('a scanner with several zones: the first open one decides', () => {
    const d = run({ plan: 'offpeak' }, { scannerZoneIds: ['pool', 'studio'] });
    expect(d).toMatchObject({ allowed: true, access: { zone: { id: 'studio' } } });
  });
  it('when none is open, the soonest to open is named', () => {
    const d = run(
      { plan: 'offpeak' },
      { now: z('2026-11-17T06:30:00Z'), scannerZoneIds: ['pool', 'studio'] },
    );
    expect(d).toMatchObject({
      reason: 'outside_hours',
      access: { zone: { id: 'studio' }, nextOpenAt: z('2026-11-17T14:00:00Z') },
    });
  });
  it('covered zones win over uncovered ones in the scanner order', () => {
    const d = run({ plan: 'hill_all' }, { scannerZoneIds: ['qa', 'pool'] });
    expect(d).toMatchObject({ allowed: true, access: { zone: { id: 'pool' } } });
  });
  it('no scanner zones: any zone the pass opens', () => {
    expect(run({ plan: 'hill_all' }).allowed).toBe(true);
    expect(run({ plan: 'gold' }, { zones: [] }).allowed).toBe(true);
    expect(run({ plan: 'hill_all' }, { zones: [] }).reason).toBe('zone_not_included');
  });
  it('archived zones and archived ancestors grant nothing', () => {
    const zones = ZONES.map((v) => (v.id === 'main' ? { ...v, archived: true } : v));
    expect(run({ plan: 'hill_all' }, { zones, scannerZoneIds: ['main'] }).reason).toBe(
      'zone_not_included',
    );
    expect(run({ plan: 'hill_all' }, { zones, scannerZoneIds: ['studio'] }).reason).toBe(
      'zone_not_included',
    );
    expect(run({ plan: 'hill_all' }, { zones, scannerZoneIds: ['pool'] }).allowed).toBe(true);
    expect(run({ plan: 'hill_all' }, { zones, scannerZoneIds: ['ghost'] }).reason).toBe(
      'zone_not_included',
    );
  });
  it('the zone clock beats the session clock; the root decides for its children', () => {
    expect(run({ plan: 'offpeak' }, { scannerZoneIds: ['studio'] }).access.timeZone).toBe(
      'America/Los_Angeles',
    );
    const early = z('2026-11-16T13:00:00Z'); // 05:00 in Los Angeles, 13:00 UTC
    expect(run({ plan: 'offpeak' }, { now: early, scannerZoneIds: ['studio'] }).reason).toBe(
      'outside_hours',
    );
    expect(run({ plan: 'night' }, { now: z('2026-11-20T23:00:00Z'), zones: [] })).toMatchObject({
      allowed: true,
      access: { timeZone: 'UTC' },
    });
    expect(run({ plan: 'gold' }, { zones: [] }).access.timeZone).toBe('UTC');
  });
  it('closesAt is the hours end, or the earlier pass end', () => {
    const d = run({ plan: 'offpeak' }, { scannerZoneIds: ['studio'] });
    expect(d.access.closesAt).toBe(z('2026-11-17T06:00:00Z'));
    const e = run(
      { plan: 'offpeak', until: '2026-11-16T21:00:00Z' },
      { scannerZoneIds: ['studio'] },
    );
    expect(e.access.closesAt).toBe(z('2026-11-16T21:00:00Z'));
    expect(run({ plan: 'gold', until: '2026-12-31T00:00:00Z' }).access.closesAt).toBe(
      z('2026-12-31T00:00:00Z'),
    );
  });
});

describe('guests', () => {
  it('defaults to local midnight after the start day', () => {
    const createdAt = z('2026-11-16T10:00:00Z');
    const base = { createdAt, scannerZoneIds: ['pool'] };
    expect(run({ plan: 'guest' }, { ...base, now: z('2026-11-17T07:59:00Z') }).allowed).toBe(true);
    expect(run({ plan: 'guest' }, { ...base, now: z('2026-11-17T08:00:00Z') }).reason).toBe(
      'guest_expired',
    );
    expect(
      run({ plan: 'guest' }, { ...base, now: z('2026-11-17T07:59:00Z') }).access.closesAt,
    ).toBe(z('2026-11-17T08:00:00Z'));
  });
  it('days: 3 runs to the third midnight, across a DST night', () => {
    const createdAt = z('2026-03-07T20:00:00Z'); // Sat in New York, DST starts Sunday
    const zones = [zone('ny', 'ny', null, { timeZone: 'America/New_York' })];
    const base = { createdAt, zones, scannerZoneIds: ['ny'] };
    expect(run({ plan: 'three' }, { ...base, now: z('2026-03-10T03:59:00Z') }).allowed).toBe(true);
    const end = run({ plan: 'three' }, { ...base, now: z('2026-03-10T04:00:00Z') });
    expect(end).toMatchObject({ reason: 'guest_expired', at: z('2026-03-10T04:00:00Z') });
  });
  it('from and until inputs set the window; the visit limit is the pass, else the plan', () => {
    const inputs = { plan: 'guest', from: '2026-11-16T00:00:00Z', until: '2026-11-18T00:00:00Z' };
    expect(run(inputs).allowed).toBe(true);
    expect(run(inputs).visitLimit).toBe(2);
    expect(run({ ...inputs, visits: 5 }).visitLimit).toBe(5);
    expect(run({ ...inputs, visits: 0 }).visitLimit).toBe(2);
    expect(run({ plan: 'gold' }).visitLimit).toBeNull();
    expect(run({ plan: 'three', until: '2026-11-18T00:00:00Z' }).visitLimit).toBeNull();
  });
});

describe('text and scope', () => {
  it('writes hours the way the pass face does', () => {
    expect(
      hoursText({
        mon: ['06:00-16:00', '20:00-23:00'],
        tue: ['06:00-16:00', '20:00-23:00'],
        wed: ['06:00-16:00', '20:00-23:00'],
        sat: ['08:00-20:00'],
        sun: ['08:00-20:00'],
      }),
    ).toBe('Mon–Wed 6 AM–4 PM, 8 PM–11 PM · Sat–Sun 8 AM–8 PM');
    expect(hoursText({ fri: ['22:00-02:00'], thu: ['06:30-24:00'] })).toBe(
      'Thu 6:30 AM–12 AM · Fri 10 PM–2 AM',
    );
    expect(hoursText(undefined)).toBe('');
  });
  it('names zones', () => {
    expect(zonesText(PLANS[2] as AccessPlan, new Map([['pool', 'Pool']]))).toBe(
      'capitol-hill, Pool',
    );
    expect(zonesText(PLANS[0] as AccessPlan)).toBe('Every zone');
  });
  it('builds the access scope, or null for an unknown plan', () => {
    const options = { createdAt: z('2026-11-16T10:00:00Z'), timeZone: 'America/New_York' };
    expect(accessScope(ACCESS, { plan: 'guest' }, options)).toMatchObject({
      plan: 'Guest day',
      kind: 'guest',
      until: z('2026-11-17T05:00:00Z'),
    });
    expect(
      accessScope(ACCESS, { plan: 'gold', until: '2026-12-31T00:00:00Z' }, options)?.until,
    ).toBe(z('2026-12-31T00:00:00Z'));
    expect(accessScope(ACCESS, { plan: 'x' }, options)).toBeNull();
  });
});
