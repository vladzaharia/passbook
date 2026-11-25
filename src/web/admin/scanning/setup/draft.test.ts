import { describe, expect, it } from 'vitest';
import { planScanSetup } from '@/shared/scan-setup-plan.ts';
import type { SetupPlanContext } from '@/shared/scan-setup-plan-types.ts';
import {
  type Draft,
  initialDraft,
  newEvent,
  PRESETS,
  skipsWhen,
  stepAfter,
  stepProblem,
} from './draft.ts';
import { applyFix, toIntent } from './intent.ts';

const ctx: SetupPlanContext = {
  mode: 'live',
  orgTimeZone: 'America/Los_Angeles',
  templates: [
    { id: 't1', name: 'Monthly', plans: null, issued: { live: 1, test: 1 } },
    { id: 't2', name: 'Gala', plans: null, issued: { live: 1, test: 1 } },
  ],
  zones: [],
  events: [],
  staff: [],
};
const plan = (d: Draft) => {
  const r = planScanSetup(toIntent(d, 'o1'), ctx);
  if (!r.ok) throw new Error(r.issues.map((i) => i.code).join());
  return r.plan;
};

describe('presets pre-fill', () => {
  it('every preset starts a draft that plans once it admits any pass type', () => {
    for (const preset of PRESETS) {
      const d = { ...initialDraft(preset, 'UTC'), any: true, max: '40' };
      expect(stepProblem(d, 'where')).toBeUndefined();
      expect(plan(d).sessions).toHaveLength(1);
    }
  });
  it('Club entry: an in phone, an out phone, the inside counted', () => {
    const d = initialDraft('club', 'UTC');
    expect(d).toMatchObject({ name: 'Entrance', count: true, area: 'Inside', scanners: 'anyone' });
    expect(d.devices.map((v) => [v.layout, v.direction])).toEqual([
      ['phone', 'in'],
      ['phone', 'out'],
    ]);
  });
  it('Conference and Capacity start with their hours; Always open sends always', () => {
    const c = initialDraft('conference', 'UTC');
    expect(c.hours).toMatchObject({ mode: 'set', from: '08:00', to: '18:00' });
    expect(toIntent(c, 'o1').doors[0]?.hours).toEqual({ every: ['08:00-18:00'] });
    const open = { ...c, hours: { ...c.hours, mode: 'always' as const } };
    expect(toIntent(open, 'o1').doors[0]?.hours).toBe('always');
    expect(initialDraft('capacity', 'UTC').hours).toMatchObject({ from: '09:00', to: '17:00' });
  });
  it('Capacity asks for Max inside, in and out phones', () => {
    const d = initialDraft('capacity', 'UTC');
    expect(stepProblem(d, 'where')).toBe('Set the max inside.');
    expect(stepProblem({ ...d, max: '40' }, 'where')).toBeUndefined();
    expect(stepProblem({ ...d, count: false, max: '40' }, 'where')).toBe('Set the max inside.');
    expect(d.devices.map((v) => v.direction)).toEqual(['in', 'out']);
  });
  it('Ticket gates keep a barcode reader; Counter keeps a customer screen', () => {
    expect(initialDraft('gates', 'UTC').devices.map((v) => v.layout)).toEqual([
      'phone',
      'phone',
      'barcode',
    ]);
    expect(initialDraft('counter', 'UTC')).toMatchObject({ scanners: 'staff' });
    expect(initialDraft('counter', 'UTC').devices.map((v) => v.layout)).toEqual([
      'operator',
      'customer',
    ]);
  });
  it('Front desk: staff PIN, a tablet and a phone', () => {
    const d = initialDraft('front_desk', 'UTC');
    expect(d).toMatchObject({ name: 'Front desk', scanners: 'staff', count: false });
    expect(d.devices.map((v) => v.layout)).toEqual(['operator', 'phone']);
  });
  it('Event night: anyone as Door, one phone, no places', () => {
    const d = initialDraft('event_night', 'UTC');
    expect(d).toMatchObject({ name: 'Doors', scanners: 'anyone', as: 'door' });
    expect(toIntent(d, 'o1').places).toEqual([]);
  });
  it('Several areas: an area tree with the door in its first area', () => {
    const d = initialDraft('venue', 'UTC');
    expect(d.areas).toHaveLength(1);
    expect(d.doorArea).toBe(d.areas[0]?.ref);
  });
  it('from a template: its pass type is checked and its issued events are asked for', () => {
    const d = initialDraft('event_night', 'UTC', 't1');
    expect(d.templateIds).toEqual(['t1']);
    expect(toIntent(d, 'o1').events).toEqual([{ fromTemplate: 't1', ref: 'template-events' }]);
  });
});

describe('steps', () => {
  it('asks each step for what it needs', () => {
    const d = initialDraft('front_desk', 'UTC');
    expect(stepProblem({ ...d, name: ' ' }, 'where')).toBe('Name the door.');
    expect(stepProblem(d, 'admits')).toBe('Pick a pass type or an event.');
    expect(stepProblem({ ...d, templateIds: ['t1'] }, 'admits')).toBeUndefined();
    // Hours on never applies a default week: they must be set.
    const on = { ...d, hours: { ...d.hours, mode: 'set' as const } };
    expect(stepProblem(on, 'when')).toBe('Set when it opens and closes.');
    expect(stepProblem({ ...on, hours: { ...on.hours, from: '06:00', to: '22:00' } }, 'when')).toBe(
      undefined,
    );
  });
  it('an event door skips When, both ways', () => {
    const d = {
      ...initialDraft('event_night', 'UTC'),
      events: [
        { ...newEvent(), name: 'Gala', date: '2026-12-05', opens: '19:00', closes: '23:00' },
      ],
    };
    expect(skipsWhen(d)).toBe(true);
    expect(stepAfter(d, 1, 1)).toBe(3);
    expect(stepAfter(d, 3, -1)).toBe(1);
    expect(stepAfter(initialDraft('front_desk', 'UTC'), 1, 1)).toBe(2);
  });
});

describe('the intent', () => {
  it('plans from the answers and derives In and out for a counted place', () => {
    const d = {
      ...initialDraft('front_desk', 'UTC'),
      count: true,
      area: 'Gym',
      max: '60',
      templateIds: ['t1'],
      staff: [{ id: 's', name: 'Sam', role: 'manager' as const }],
    };
    const p = plan(d);
    expect(p.zones[0]).toMatchObject({ name: 'Gym', capacity: 60, occupancy: 'track' });
    expect(p.sessions[0]?.settings.direction).toBe('both');
  });
  it('turns a check fix into an edit of the answers', () => {
    const d = {
      ...initialDraft('front_desk', 'UTC'),
      templateIds: ['t1'],
      staff: [{ id: 's', name: 'Sam', role: 'door' as const }],
    };
    const promoted = applyFix(d, { kind: 'add_staff', role: 'manager' });
    expect(promoted.staff[0]?.role).toBe('manager');
    const out = applyFix(d, { kind: 'add_device', session: 'door-1', direction: 'out' });
    expect(out.devices.at(-1)).toMatchObject({ layout: 'phone', direction: 'out' });
    const dir = applyFix(d, { kind: 'device_direction', device: 'door-1-2', direction: 'both' });
    expect(dir.devices[1]?.direction).toBe('both');
    expect(plan(dir).sessions[0]?.devices[1]?.overrides.direction).toBe('both');
  });
});
