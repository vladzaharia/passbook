import { makePerson } from '../people.ts';
import { type Ctx, DAY, HOUR, isoWall, MIN, memo, scatter, worldKey, worldRng } from '../world.ts';
import { AIRPORTS, distanceKm } from './airports.ts';
import { D, type DatasetDef, PERSON_FIELDS, personFields, S } from './types.ts';

/** Fictional carriers. A code with a digit in third place cannot be an IATA (2 characters) or ICAO (3 letters) designator. */
const CARRIERS = [
  ['ZA1', 'Skylark Air'],
  ['ZB1', 'Meridian Jet'],
  ['ZC1', 'Larkspur Airways'],
  ['ZD1', 'Cobalt Air'],
  ['ZE1', 'Tern Airlines'],
  ['ZF1', 'Quill Air'],
] as const;

interface Flight {
  code: string;
  number: number;
  from: (typeof AIRPORTS)[number];
  to: (typeof AIRPORTS)[number];
  /** Departure instant. */
  departs: number;
  minutes: number;
  gate: string;
}

const flights = (x: Ctx): Flight[] =>
  memo(worldKey(x.c), () => {
    const r = worldRng(x.c);
    return Array.from({ length: r.range(4, 8) }, () => {
      const from = r.pick(AIRPORTS);
      let to = r.pick(AIRPORTS);
      while (to === from) to = r.pick(AIRPORTS);
      const wall = x.t0 + r.range(3, 60) * DAY + r.range(6, 21) * HOUR + r.int(12) * 5 * MIN;
      // About 800 km/h plus 40 minutes of taxi and climb, rounded to 5 minutes.
      const minutes = Math.round((distanceKm(from, to) / 800) * 12 + 8) * 5;
      return {
        code: r.pick(CARRIERS)[0],
        number: r.range(100, 999),
        from,
        to,
        departs: wall - from.offset * HOUR,
        minutes,
        gate: `${r.pick(['A', 'B', 'C', 'D'])}${r.range(1, 30)}`,
      };
    });
  });

export const boardingPasses: DatasetDef = {
  prefix: 'p-',
  pad: 4,
  pageSize: 50,
  fields: {
    ...PERSON_FIELDS,
    passengerGiven: S,
    passengerFamily: S,
    airlineCode: S,
    flightNumber: S,
    origin: S,
    originCity: S,
    originTimeZone: S,
    destination: S,
    destinationCity: S,
    destinationTimeZone: S,
    boardsAt: D,
    departsAt: D,
    arrivesAt: D,
    gate: S,
    seat: S,
    boardingGroup: S,
    ticketId: S,
    transitType: S,
  },
  bad: ['passengerGiven', 'ticketId'],
  build(x, index, r) {
    const p = makePerson(x, r, index);
    const all = flights(x);
    const f = all[(index - 1) % all.length] as Flight;
    // Seats are a bijection of the passenger's place on the flight: 50 rows of A to F, never repeated.
    const slot = (Math.floor((index - 1) / all.length) * 7 + 3) % 300;
    return {
      holderEmail: p.email,
      record: {
        ...personFields(p),
        passengerGiven: p.firstName,
        passengerFamily: p.lastName,
        airlineCode: f.code,
        flightNumber: f.number,
        origin: f.from.iata,
        originCity: f.from.city,
        originTimeZone: f.from.tz,
        destination: f.to.iata,
        destinationCity: f.to.city,
        destinationTimeZone: f.to.tz,
        boardsAt: isoWall(f.departs + f.from.offset * HOUR - 40 * MIN, f.from.offset),
        departsAt: isoWall(f.departs + f.from.offset * HOUR, f.from.offset),
        arrivesAt: isoWall(f.departs + f.minutes * MIN + f.to.offset * HOUR, f.to.offset),
        gate: f.gate,
        seat: `${Math.floor(slot / 6) + 1}${'ABCDEF'[slot % 6]}`,
        boardingGroup: String(r.range(1, 5)),
        ticketId: `ZT-${scatter(index, 100000000, 900000000)}`,
        transitType: 'air',
      },
    };
  },
  change(_x, _i, record, r) {
    record.gate = `${r.pick(['A', 'B', 'C', 'D'])}${r.range(1, 30)}`;
    record.boardingGroup = String(r.range(1, 5));
  },
};
