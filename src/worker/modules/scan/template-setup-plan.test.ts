import { describe, expect, it } from 'vitest';
import type { PassJson, TemplateManifest } from '../../../passkit/types.ts';
import { hoursForEvents, planTemplateScan } from './template-setup-plan.ts';

const NOW = Date.parse('2030-01-01T00:00:00Z');
const manifest = (over: Partial<TemplateManifest>): TemplateManifest =>
  ({
    schema: 1,
    name: 'T',
    inputs: { type: 'object' },
    sample: {},
    bindings: [],
    display: { title: 'x' },
    ...over,
  }) as TemplateManifest;
const pass = (semantics?: object) => ({ semantics }) as unknown as PassJson;

describe('planTemplateScan', () => {
  it('has no events for a door template', () => {
    const plan = planTemplateScan(manifest({ sample: { memberName: 'Alex' } }), pass(), NOW);
    expect(plan).toEqual({ events: [], undated: [], checkIn: undefined });
  });

  it('reads the event from the pass semantics when the sample has none', () => {
    const plan = planTemplateScan(
      manifest({}),
      pass({
        eventName: 'Gala',
        eventStartDate: '2030-06-01T19:00:00Z',
        venueName: 'Hall',
      }),
      NOW,
    );
    expect(plan.events).toEqual([
      {
        name: 'Gala',
        opensAt: Date.parse('2030-06-01T19:00:00Z'),
        closesAt: Date.parse('2030-06-01T22:00:00Z'),
        timeZone: null,
        venue: 'Hall',
      },
    ]);
  });

  it('copies the template check-in rules and ignores empty ones', () => {
    const rules = planTemplateScan(
      manifest({
        scan: {
          actions: [],
          checkIn: { mode: 'single', durationMinutes: 90, durationFrom: 'issued' },
        },
      }),
      pass(),
      NOW,
    );
    expect(rules.checkIn).toEqual({ mode: 'single', durationMinutes: 90, durationFrom: 'issued' });
    expect(
      planTemplateScan(manifest({ scan: { actions: [], checkIn: {} } }), pass(), NOW).checkIn,
    ).toBeUndefined();
  });

  it('caps the list at ten events', () => {
    const upcomingEvents = Array.from({ length: 14 }, (_, i) => ({
      name: `Night ${i + 1}`,
      startsAt: `2030-07-${String(i + 1).padStart(2, '0')}T19:00:00Z`,
    }));
    const plan = planTemplateScan(
      manifest({
        sample: { upcomingEvents },
        behaviors: [{ use: 'upcoming-events', version: 1, config: { input: 'upcomingEvents' } }],
      }),
      pass(),
      NOW,
    );
    expect(plan.events.map((e) => e.name)).toEqual(
      Array.from({ length: 10 }, (_, i) => `Night ${i + 1}`),
    );
  });
});

describe('hoursForEvents', () => {
  it('opens on the weekday of each event from doors to close, in the zone', () => {
    const hours = hoursForEvents(
      [
        {
          opensAt: Date.parse('2030-06-01T18:00:00-07:00'),
          closesAt: Date.parse('2030-06-01T23:00:00-07:00'),
        },
      ],
      'America/Los_Angeles',
    );
    expect(hours).toEqual({ sat: ['18:00-23:00'] });
  });

  it('runs a span past midnight and merges overlapping ones', () => {
    const at = (iso: string) => Date.parse(iso);
    expect(
      hoursForEvents(
        [
          { opensAt: at('2030-06-01T22:00:00Z'), closesAt: at('2030-06-02T02:00:00Z') },
          { opensAt: at('2030-06-08T23:00:00Z'), closesAt: at('2030-06-09T01:00:00Z') },
        ],
        'UTC',
      ),
    ).toEqual({ sat: ['22:00-02:00'] });
  });

  it('stays always open for an event of a day or more', () => {
    expect(hoursForEvents([{ opensAt: 0, closesAt: 86_400_000 * 2 }], 'UTC')).toBeNull();
    expect(hoursForEvents([], 'UTC')).toBeNull();
  });
});
