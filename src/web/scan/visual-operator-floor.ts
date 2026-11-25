/** The floor, Who's in and the roll call for the operator gallery. One clock with the lists and the record. */
import type { RollCall, RollCallPerson } from '../../shared/contracts/scan-roll-call.ts';
import type { ScanApi } from './api/scan-api.ts';
import type { InsideRow } from './inside/inside-types.ts';
import { GALLERY_NOW } from './visual-operator-record.ts';

export const FLOOR_CASES = ['floor', 'inside', 'rollcall', 'rollcall-record'] as const;

const NOW = GALLERY_NOW;
const MIN = 60_000;
const id = (n: number) => `01900000-0000-7000-8000-0000000005${n.toString().padStart(2, '0')}`;
const PLACES = [
  { place: 'z-all', name: 'Northside Gym', inNow: 42, capacity: 60, rev: 9 },
  { place: 'z-gym', name: 'Gym floor', inNow: 19, capacity: 40, rev: 9 },
  { place: 'z-pool', name: 'Pool', inNow: 12, capacity: 12, rev: 9 },
  { place: 'z-studio', name: 'Studio', inNow: 8, capacity: 20, rev: 9 },
  { place: 'z-sauna', name: 'Sauna', inNow: 3, capacity: 6, rev: 9 },
];
const PEOPLE: [string, string, string, number, string | null][] = [
  ['Priya Natarajan', 'Gym floor', 'z-gym', 82, 'Front desk · Theo B.'],
  ['Kwame Okafor', 'Gym floor', 'z-gym', 75, 'Turnstile A'],
  ['Ada Okafor', 'Gym floor', 'z-gym', 75, 'Turnstile A'],
  ['Aiko Tanaka', 'Studio', 'z-studio', 68, 'Studio door'],
  ['Elif Demir', 'Pool', 'z-pool', 66, 'Pool gate'],
  ['Fatima El Idrissi', 'Gym floor', 'z-gym', 54, 'Front desk · Ana R.'],
  ['Hana Sato', 'Sauna', 'z-sauna', 41, 'Front desk · Theo B.'],
  ['Noah Fischer', 'Pool', 'z-pool', 33, 'Pool gate'],
  ['Maya Okafor', 'Gym floor', 'z-gym', 1, 'Front desk · Theo B.'],
];

const insideRows = (): InsideRow[] =>
  PEOPLE.map(([name, zone, place, min, via], i) => ({
    passId: id(i + 1),
    holder: name,
    photoUrl: null,
    plan: null,
    type: 'Member',
    place,
    since: NOW - min * MIN,
    via,
    flags: min > 80 ? ['long_stay' as const] : [],
    zone: { name: zone, parent: null },
    dueAt: null,
    host: null,
  }));

const person = (
  i: number,
  mark: RollCallPerson['mark'],
  over: Partial<RollCallPerson> = {},
): RollCallPerson => {
  const [name, zone, place, min] = PEOPLE[i % PEOPLE.length] ?? PEOPLE[0] ?? ['', '', '', 0, null];
  return {
    passId: id(i + 1),
    holder: name,
    plan: i === 4 ? 'Visitor' : null,
    host: null,
    place,
    placeName: zone,
    since: NOW - min * MIN,
    basis: 'in_now',
    presence: 'in',
    late: false,
    mark,
    notConfirmedOut: false,
    ...over,
  } as RollCallPerson;
};

function call(): RollCall {
  const by = (who: string, n: number) => ({
    status: 'present' as const,
    by: who,
    at: NOW - n * MIN,
  });
  const people = [
    person(0, null),
    person(1, null),
    person(2, by('Front desk · Theo B.', 3)),
    person(3, by('Pool gate · Jonas W.', 4)),
    person(4, null, { presence: 'lapsed', notConfirmedOut: true }),
    person(5, by('Front desk · Theo B.', 2)),
    person(
      6,
      { status: 'out', by: 'Pool gate · Jonas W.', at: NOW - 5 * MIN },
      { presence: 'left' },
    ),
    person(7, null),
    person(8, by('Front desk · Theo B.', 1)),
  ];
  const n = (f: (p: RollCallPerson) => boolean) => people.filter(f).length;
  return {
    id: id(90),
    placeNames: ['Whole building'],
    startedAt: NOW - 4 * MIN,
    startedBy: 'Ana R.',
    endedAt: null,
    endedBy: null,
    rev: 4,
    serverNow: NOW,
    counts: {
      total: people.length,
      present: n((p) => p.mark?.status === 'present'),
      out: n((p) => p.mark?.status === 'out'),
      unconfirmed: n((p) => !p.mark),
      notConfirmedOut: n((p) => p.notConfirmedOut),
      late: 0,
      inNow: people.length,
      tappedIn: 0,
    },
    people,
  };
}

/** The reads the floor and its views make, over the gallery's one clock. */
export function floorApi(scenario: string): Partial<ScanApi> {
  return {
    inside: async () => ({
      places: PLACES,
      items: insideRows(),
      total: 42,
      nextCursor: null,
      asOf: NOW,
    }),
    devices: async () => ({
      items: [
        ['Front desk', true, 0],
        ['Turnstile A', true, 0],
        ['Pool gate', true, 0],
        ['Studio door', false, 4],
        ['Lobby tablet', true, 0],
      ].map(([name, online, min], i) => ({
        id: id(80 + i),
        name: String(name),
        surface: 'operator' as const,
        online: Boolean(online),
        lastSeenAt: NOW - Number(min) * MIN,
        self: i === 0,
      })),
    }),
    summary: async () =>
      ({ total: 41, ok: 38, headsUp: 0, refused: 2, undone: 1 }) as Awaited<
        ReturnType<ScanApi['summary']>
      >,
    rollCall: async () => ({ rollCall: scenario.startsWith('rollcall') ? call() : null }),
  };
}
