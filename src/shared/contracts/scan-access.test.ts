import { describe, expect, it } from 'vitest';
import {
  CreateScanZoneSchema,
  PassAccessSchema,
  ScanAccessSchema,
  ScanZoneSchema,
  SessionZonesSchema,
  UpdateScanZoneSchema,
  WeeklyHoursSchema,
  ZoneKeySchema,
} from './scan-access.ts';

const org = 'org1';
const access = {
  plan: { id: 'gold', label: '24/7 Gold', kind: 'always' },
  zone: { id: 'z1', name: 'Pool' },
  closesAt: null,
  nextOpenAt: null,
  visits: null,
  visit: true,
  timeZone: 'Europe/Berlin',
} as const;
const zone = {
  id: 'z1',
  orgId: org,
  key: 'pool',
  name: 'Pool',
  parentId: null,
  timeZone: 'Europe/Berlin',
  effectiveTimeZone: 'Europe/Berlin',
  sort: 0,
  depth: 0,
  sessions: 1,
  checkedAt: [],
  plans: [],
  occupancy: 'track',
  capacity: 25,
  maxStayMinutes: 720,
  clearAt: '23:00',
  inNow: 3,
  archivedAt: null,
} as const;

describe('access contracts', () => {
  it('still parses the access object a verdict carries', () => {
    expect(ScanAccessSchema.parse(access)).toEqual(access);
    expect(
      ScanAccessSchema.safeParse({ ...access, plan: { ...access.plan, kind: 'vip' } }).success,
    ).toBe(false);
  });
  it('checks zone keys and weekly hours', () => {
    expect(ZoneKeySchema.safeParse('pool-2').success).toBe(true);
    for (const bad of ['', 'Pool', '-pool', 'a'.repeat(41), 'a b']) {
      expect(ZoneKeySchema.safeParse(bad).success).toBe(false);
    }
    expect(
      WeeklyHoursSchema.safeParse({ mon: ['06:00-10:00', '22:00-02:00'], sun: ['00:00-24:00'] })
        .success,
    ).toBe(true);
    for (const bad of [
      { mon: ['6:00-10:00'] },
      { mon: ['24:00-02:00'] },
      { mon: [] },
      { fri: ['1-2'] },
      { xyz: ['06:00-10:00'] },
    ]) {
      expect(WeeklyHoursSchema.safeParse(bad).success).toBe(false);
    }
    const five = Array.from({ length: 5 }, (_, i) => `0${i}:00-0${i}:30`);
    expect(WeeklyHoursSchema.safeParse({ mon: five }).success).toBe(false);
  });
  it('accepts a zone and rejects limits without tracking', () => {
    expect(ScanZoneSchema.parse(zone)).toEqual(zone);
    const create = { orgId: org, key: 'pool', name: 'Pool' };
    expect(CreateScanZoneSchema.safeParse(create).success).toBe(true);
    expect(
      CreateScanZoneSchema.safeParse({ ...create, occupancy: 'enforce', capacity: 25 }).success,
    ).toBe(true);
    expect(CreateScanZoneSchema.safeParse({ ...create, capacity: 25 }).success).toBe(false);
    expect(
      CreateScanZoneSchema.safeParse({ ...create, occupancy: 'off', clearAt: '23:00' }).success,
    ).toBe(false);
    expect(
      CreateScanZoneSchema.safeParse({ ...create, clearAt: '24:00', occupancy: 'track' }).success,
    ).toBe(false);
    expect(
      CreateScanZoneSchema.safeParse({ ...create, maxStayMinutes: 5, occupancy: 'track' }).success,
    ).toBe(false);
    expect(CreateScanZoneSchema.safeParse({ ...create, extra: 1 }).success).toBe(false);
  });
  it('an update names only what changes', () => {
    expect(UpdateScanZoneSchema.parse({ name: 'Pool 2' })).toEqual({ name: 'Pool 2' });
    expect(UpdateScanZoneSchema.parse({ occupancy: 'off', capacity: null })).toEqual({
      occupancy: 'off',
      capacity: null,
    });
    expect(UpdateScanZoneSchema.safeParse({ occupancy: 'off', capacity: 5 }).success).toBe(false);
    expect(UpdateScanZoneSchema.safeParse({ key: 'other' }).success).toBe(false);
  });
  it('bounds a session to 8 distinct zones', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `z${i}`);
    expect(SessionZonesSchema.safeParse({ zoneIds: ids(8) }).success).toBe(true);
    expect(SessionZonesSchema.safeParse({ zoneIds: ids(9) }).success).toBe(false);
    expect(SessionZonesSchema.safeParse({ zoneIds: ['a', 'a'] }).success).toBe(false);
  });
  it('describes a pass access card', () => {
    const card = {
      plan: access.plan,
      zones: [{ id: 'z1', name: 'Pool' }],
      openNow: true,
      nextOpenAt: null,
      visits: { used: 1, limit: 3 },
      lastVisitAt: 5,
      suspended: false,
    };
    expect(PassAccessSchema.parse(card)).toEqual(card);
    expect(PassAccessSchema.safeParse({ ...card, openNow: 'yes' }).success).toBe(false);
  });
});
