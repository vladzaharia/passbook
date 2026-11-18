import { describe, expect, it } from 'vitest';
import {
  OccupancySettingsSchema,
  OVERRIDE_NOTES,
  PlaceKeySchema,
  ScanInsideListSchema,
  ScanMarkOutRequestSchema,
  ScanOverrideNoteRequestSchema,
  ScanOverrideRequestSchema,
  ScanPlaceRevSchema,
} from './scan-occupancy.ts';

const key = '01900000-0000-7000-8000-0000000000aa';

describe('occupancy contracts', () => {
  it('names a place as zone or event', () => {
    expect(PlaceKeySchema.safeParse('zone:z1').success).toBe(true);
    expect(PlaceKeySchema.safeParse('event:e1').success).toBe(true);
    for (const bad of ['z1', 'door:z1', 'zone:', 'zone:a b']) {
      expect(PlaceKeySchema.safeParse(bad).success).toBe(false);
    }
  });
  it('limits need tracking, and the ranges hold', () => {
    const off = { occupancy: 'off', capacity: null, maxStayMinutes: null, clearAt: null };
    expect(OccupancySettingsSchema.safeParse(off).success).toBe(true);
    expect(OccupancySettingsSchema.safeParse({ ...off, capacity: 1 }).success).toBe(false);
    const on = {
      ...off,
      occupancy: 'enforce',
      capacity: 100_000,
      maxStayMinutes: 2880,
      clearAt: '00:00',
    };
    expect(OccupancySettingsSchema.safeParse(on).success).toBe(true);
    for (const bad of [
      { capacity: 0 },
      { capacity: 100_001 },
      { maxStayMinutes: 14 },
      { maxStayMinutes: 2881 },
      { clearAt: '7:00' },
      { clearAt: '24:00' },
    ]) {
      expect(OccupancySettingsSchema.safeParse({ ...on, ...bad }).success).toBe(false);
    }
  });
  it('takes an override with an optional note and approval', () => {
    const req = { idempotencyKey: key, overrideOf: 'scan1' };
    expect(ScanOverrideRequestSchema.safeParse(req).success).toBe(true);
    expect(
      ScanOverrideRequestSchema.safeParse({ ...req, note: 'paid', approval: { pin: '123456' } })
        .success,
    ).toBe(true);
    expect(ScanOverrideRequestSchema.safeParse({ ...req, note: 'because' }).success).toBe(false);
    expect(ScanOverrideRequestSchema.safeParse({ ...req, approval: { pin: '12' } }).success).toBe(
      false,
    );
    expect(ScanOverrideRequestSchema.safeParse({ ...req, direction: 'out' }).success).toBe(false);
    expect(
      ScanOverrideRequestSchema.safeParse({ idempotencyKey: 'x', overrideOf: 'a' }).success,
    ).toBe(false);
    for (const note of OVERRIDE_NOTES) {
      expect(ScanOverrideNoteRequestSchema.safeParse({ note }).success).toBe(true);
    }
  });
  it('takes a mark-out for a place', () => {
    const req = { idempotencyKey: key, passId: 'p1', place: 'zone:z1' };
    expect(ScanMarkOutRequestSchema.safeParse(req).success).toBe(true);
    expect(ScanMarkOutRequestSchema.safeParse({ ...req, place: 'z1' }).success).toBe(false);
    expect(ScanMarkOutRequestSchema.safeParse({ ...req, passId: undefined }).success).toBe(false);
  });
  it('bounds the inside list and orders counts by rev', () => {
    const row = {
      passId: 'p1',
      holder: 'Leo Park',
      photoUrl: null,
      plan: 'Gold',
      place: 'zone:z1',
      since: 5,
      via: 'Pool gate',
      flags: ['long_stay'],
    };
    expect(
      ScanInsideListSchema.safeParse({ items: [row], total: 1, nextCursor: null }).success,
    ).toBe(true);
    expect(
      ScanInsideListSchema.safeParse({ items: Array(101).fill(row), total: 101, nextCursor: null })
        .success,
    ).toBe(false);
    expect(
      ScanInsideListSchema.safeParse({
        items: [{ ...row, flags: ['lost'] }],
        total: 1,
        nextCursor: null,
      }).success,
    ).toBe(false);
    const rev = { place: 'zone:z1', name: 'Pool', inNow: 3, capacity: null, rev: 0 };
    expect(ScanPlaceRevSchema.safeParse(rev).success).toBe(true);
    expect(ScanPlaceRevSchema.safeParse({ ...rev, rev: -1 }).success).toBe(false);
  });
});
