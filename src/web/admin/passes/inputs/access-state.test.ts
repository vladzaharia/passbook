import { describe, expect, it } from 'vitest';
import type { AccessManifest } from '@/passkit/types.ts';
import { accessOf, accessState } from './access-state.ts';

const access: AccessManifest = {
  input: { plan: 'plan', zones: 'zones', from: 'starts', until: 'ends' },
  suspend: { input: 'status', equals: ['Suspended'] },
  plans: [
    { id: 'gold', label: '24/7 Gold', kind: 'always', zones: [{ zone: '*' }] },
    {
      id: 'offpeak',
      label: 'Off-peak',
      kind: 'timed',
      hours: { mon: ['06:00-16:00'], sat: ['08:00-20:00'] },
      zones: [{ zone: 'gym' }],
    },
  ],
};
const zones = [
  { key: 'gym', name: 'Gym floor', timeZone: 'America/Chicago' },
  { key: 'pool', name: 'Pool', timeZone: 'America/Chicago' },
];
// Monday 2026-11-16 10:00 in Chicago.
const monday = Date.parse('2026-11-16T16:00:00Z');
const state = (inputs: Record<string, unknown>, now = monday) =>
  accessState(access, inputs, zones, now, 'UTC');

describe('accessState', () => {
  it('is open inside the plan hours, in the zone clock', () => {
    const s = state({ plan: 'offpeak' });
    expect(s.status).toEqual({ kind: 'open' });
    expect(s.timeZone).toBe('America/Chicago');
    expect(s.zones).toEqual([{ key: 'gym', name: 'Gym floor', extra: false }]);
  });

  it('opens next on Saturday when it is closed', () => {
    const tuesday = Date.parse('2026-11-17T16:00:00Z');
    const s = state({ plan: 'offpeak' }, tuesday);
    expect(s.status).toEqual({ kind: 'opens', at: Date.parse('2026-11-21T14:00:00Z') });
  });

  it('adds extra zones after the plan zones, once each', () => {
    const s = state({ plan: 'offpeak', zones: ['pool', 'gym', 'steam'] });
    expect(s.zones.map((z) => [z.name, z.extra])).toEqual([
      ['Gym floor', false],
      ['Pool', true],
      ['steam', true],
    ]);
    expect(state({ plan: 'gold' }).zones[0]).toMatchObject({ name: 'Every zone' });
  });

  it('puts suspension, start and end before the hours', () => {
    expect(state({ plan: 'gold', status: 'Suspended' }).status).toEqual({ kind: 'suspended' });
    const later = '2026-12-01T00:00:00Z';
    expect(state({ plan: 'gold', starts: later }).status).toEqual({
      kind: 'not_started',
      at: Date.parse(later),
    });
    const past = '2026-11-01T00:00:00Z';
    expect(state({ plan: 'gold', ends: past }).status).toEqual({
      kind: 'ended',
      at: Date.parse(past),
    });
  });

  it('keeps the id of a plan the template no longer has', () => {
    const s = state({ plan: 'retired' });
    expect(s.plan).toBeNull();
    expect(s.unknown).toBe('retired');
  });

  it('reads the access block from a manifest, or null', () => {
    expect(accessOf({ scan: { access } })).toBe(access);
    expect(accessOf({ scan: {} })).toBeNull();
    expect(accessOf(null)).toBeNull();
  });
});
