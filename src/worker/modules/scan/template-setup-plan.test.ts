import { describe, expect, it } from 'vitest';
import type { TemplateManifest } from '../../../passkit/types.ts';
import { checkInOf, eventSource, plainText, planEvents } from './template-setup-plan.ts';

const NOW = Date.parse('2030-01-01T00:00:00Z');
const HOUR = 3_600_000;
const manifest = (over: Partial<TemplateManifest> & { props?: string[] }): TemplateManifest => {
  const { props = [], ...rest } = over;
  return {
    schema: 1,
    name: 'T',
    inputs: {
      type: 'object',
      properties: Object.fromEntries(props.map((p) => [p, { type: 'string' }])),
    },
    sample: {},
    bindings: [],
    display: { title: 'x' },
    ...rest,
  } as TemplateManifest;
};

describe('eventSource', () => {
  it('has none for a door template, whatever its sample says', () => {
    const m = manifest({
      props: ['memberName'],
      sample: { eventName: 'Sample', startsAt: '2030-06-01T19:00:00Z' },
    });
    expect(eventSource(m)).toMatchObject({ own: null, list: null });
  });

  it('names the inputs a ticket holds its event in', () => {
    const m = manifest({
      props: ['eventName', 'slotStart', 'slotEnd', 'doorsAt', 'venueName', 'upcoming'],
      scan: {
        actions: [],
        window: { from: 'slotStart', until: 'slotEnd', earlyMinutes: 15, lateMinutes: 5 },
      },
      behaviors: [{ use: 'upcoming-events', version: 1, config: { input: 'upcoming' } }],
    });
    expect(eventSource(m)).toEqual({
      own: {
        name: 'eventName',
        start: 'slotStart',
        end: 'slotEnd',
        doors: 'doorsAt',
        venueName: 'venueName',
        venueRegion: null,
        zone: null,
      },
      list: 'upcoming',
      early: 15,
      late: 5,
    });
  });

  it('ignores an input name that is not a plain identifier', () => {
    const m = manifest({
      props: ['eventName', 'startsAt'],
      scan: { actions: [], window: { from: 'a"b' } },
    });
    expect(eventSource(m).own?.start).toBe('startsAt');
  });
});

describe('planEvents', () => {
  const source = eventSource(
    manifest({
      props: ['eventName', 'startsAt', 'endsAt', 'doorsAt'],
      scan: { actions: [], window: { from: 'startsAt', earlyMinutes: 30, lateMinutes: 10 } },
    }),
  );
  const at = (h: number) => new Date(NOW + h * HOUR).toISOString();

  it('plans each distinct event once, soonest first, from doors to the end plus the late minutes', () => {
    const plan = planEvents(
      't1',
      source,
      [
        { name: 'B', startsAt: at(48), endsAt: at(50), own: true },
        { name: 'A', startsAt: at(2), endsAt: at(4), doorsAt: at(1), own: true },
        { name: 'A', startsAt: at(2), endsAt: at(4), doorsAt: at(1), own: true },
        { name: 'A', startsAt: at(2), endsAt: at(4) },
      ],
      NOW,
    );
    expect(plan.map((e) => [e.name, e.opensAt, e.closesAt, e.matchInput])).toEqual([
      ['A', NOW + HOUR, NOW + 4 * HOUR + 10 * 60_000, 'eventName'],
      ['B', NOW + 48 * HOUR - 30 * 60_000, NOW + 50 * HOUR + 10 * 60_000, 'eventName'],
    ]);
  });

  it('drops past events and rows with no name or date, and never matches a list entry', () => {
    const plan = planEvents(
      't1',
      source,
      [
        { name: 'Past', startsAt: at(-10), endsAt: at(-9) },
        { name: 'Running', startsAt: at(-1), endsAt: at(1) },
        { startsAt: at(5) },
        { name: 'No date' },
        { name: 'Listed', startsAt: at(9) },
      ],
      NOW,
    );
    expect(plan.map((e) => [e.name, e.matchInput])).toEqual([
      ['Running', null],
      ['Listed', null],
    ]);
  });

  it('cleans the name and keeps a name it changed out of the match', () => {
    const [e] = planEvents('t1', source, [{ name: 'Gala\n‮txt', startsAt: at(3), own: true }], NOW);
    expect(e).toMatchObject({ name: 'Gala txt', matchInput: null });
  });

  it('plans at most ten events', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ name: `N${i}`, startsAt: at(i + 1) }));
    expect(planEvents('t1', source, many, NOW)).toHaveLength(10);
  });
});

describe('plainText', () => {
  it('strips controls and bidi marks, cuts by characters and refuses an empty line', () => {
    expect(plainText('a‮b\nc', 80)).toBe('a b c');
    expect(plainText('😀😀😀', 2)).toBe('😀😀');
    expect(plainText(' \n ', 80)).toBeNull();
    expect(plainText(5, 80)).toBeNull();
  });
});

describe('checkInOf', () => {
  it('copies the template check-in rules and ignores empty ones', () => {
    expect(
      checkInOf(
        manifest({
          scan: {
            actions: [],
            checkIn: { mode: 'single', durationMinutes: 90, durationFrom: 'issued' },
          },
        }),
      ),
    ).toEqual({
      mode: 'single',
      durationMinutes: 90,
      durationFrom: 'issued',
    });
    expect(checkInOf(manifest({ scan: { actions: [], checkIn: {} } }))).toBeUndefined();
    expect(checkInOf(manifest({}))).toBeUndefined();
  });
});
