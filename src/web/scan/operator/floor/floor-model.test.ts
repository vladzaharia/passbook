import { describe, expect, it } from 'vitest';
import type { RollCall, RollCallPerson } from '../../../../shared/contracts/scan-roll-call.ts';
import { byDevice, byZone, deviceState, nextToConfirm, rollRows, viewsFor } from './floor-model.ts';

const person = (passId: string, over: Partial<RollCallPerson> = {}): RollCallPerson => ({
  passId,
  holder: passId,
  plan: null,
  host: null,
  place: 'z',
  placeName: 'Gym floor',
  since: 100,
  basis: 'in_now',
  presence: 'in',
  late: false,
  mark: null,
  notConfirmedOut: false,
  ...over,
});
const call = (people: RollCallPerson[]) => ({ people }) as unknown as RollCall;
const by = (who: string) => ({ status: 'present' as const, by: who, at: 1 });

describe('the roll call by zone and by desk', () => {
  const c = call([
    person('a', { mark: by('Front desk') }),
    person('b', { placeName: 'Pool' }),
    person('c', { mark: by('Front desk') }),
    person('d', { mark: { status: 'none', by: 'Gate', at: 1 } }),
  ]);
  it('counts confirmed against listed in each zone, a taken-back mark not counted', () => {
    expect(byZone(c)).toEqual([
      { name: 'Gym floor', marked: 2, total: 3 },
      { name: 'Pool', marked: 0, total: 1 },
    ]);
  });
  it('tallies marks by who made them, most first', () => {
    expect(byDevice(c)).toEqual([{ by: 'Front desk', count: 2 }]);
  });
});

describe('the roll call piles', () => {
  const c = call([
    person('safe', { mark: by('x') }),
    person('out', { mark: { status: 'out', by: 'x', at: 1 } }),
    person('late', { since: 300 }),
    person('lapsed', { since: 500, notConfirmedOut: true }),
    person('early', { since: 50 }),
  ]);
  it('puts the lapsed first, then the longest inside', () => {
    expect(rollRows(c, 'open').map((p) => p.passId)).toEqual(['lapsed', 'early', 'late']);
  });
  it('splits the confirmed into Safe and Out', () => {
    expect(rollRows(c, 'present').map((p) => p.passId)).toEqual(['safe']);
    expect(rollRows(c, 'out').map((p) => p.passId)).toEqual(['out']);
    expect(rollRows(c, 'lapsed').map((p) => p.passId)).toEqual(['lapsed']);
  });
  it('names the next person to confirm after one, wrapping, and none when all are done', () => {
    const order = [person('a'), person('b', { mark: by('x') }), person('c'), person('d')];
    expect(nextToConfirm(order, 'a')).toBe('c');
    expect(nextToConfirm(order, 'd')).toBe('a');
    expect(nextToConfirm(order, null)).toBe('a');
    expect(nextToConfirm([person('a', { mark: by('x') })], 'a')).toBeNull();
  });
});

describe('devices and views', () => {
  const dev = (over: object) => ({
    id: '1',
    name: 'Door',
    surface: 'operator' as const,
    online: false,
    lastSeenAt: null,
    self: false,
    ...over,
  });
  it('says how long a device has been gone', () => {
    expect(deviceState(dev({ online: true }), 10_000_000)).toEqual({
      online: true,
      text: 'Online',
    });
    expect(deviceState(dev({ lastSeenAt: 10_000_000 - 4 * 60_000 }), 10_000_000).text).toBe(
      'Offline · 4 min',
    );
    expect(deviceState(dev({ lastSeenAt: 10_000_000 - 5 * 3_600_000 }), 10_000_000).text).toBe(
      'Offline',
    );
    expect(deviceState(dev({}), 10).text).toBe('Offline');
  });
  it('gives Who’s in a counted place only', () => {
    expect(viewsFor({ tracks: true })).toEqual(['activity', 'problems', 'inside']);
    expect(viewsFor({ tracks: false })).toEqual(['activity', 'problems']);
  });
});
