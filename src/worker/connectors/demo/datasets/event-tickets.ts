import { fullName, makePerson } from '../people.ts';
import { Rng } from '../prng.ts';
import {
  type Ctx,
  DAY,
  HOUR,
  isoWall,
  memo,
  scatter,
  title,
  worldKey,
  worldRng,
} from '../world.ts';
import { D, type DatasetDef, N, PERSON_FIELDS, personFields, S } from './types.ts';

const KIND = ['Live', 'Festival', 'Night', 'Sessions'] as const;
const VENUE = ['Arena', 'Hall', 'Theatre', 'Pavilion', 'Park'] as const;
const GATES = ['A', 'B', 'C', 'D'] as const;
const STATUS = ['valid', 'refunded', 'transferred'] as const;

interface Event {
  name: string;
  venue: string;
  region: string;
  start: number;
  lat: number;
  lng: number;
}

const events = (x: Ctx): Event[] =>
  memo(worldKey(x.c), () => {
    const r = worldRng(x.c);
    return Array.from({ length: r.range(3, 6) }, () => ({
      name: `${title(r.pick(x.words.adjective))} ${title(r.pick(x.words.noun))} ${r.pick(KIND)}`,
      venue: `${r.pick(x.words.city)} ${r.pick(VENUE)}`,
      region: r.pick(x.words.region),
      start: x.t0 + r.range(7, 120) * DAY + r.range(18, 20) * HOUR,
      lat: Math.round((x.zone.lat + (r.int(200) - 100) / 1000) * 1e4) / 1e4,
      lng: Math.round((x.zone.lng + (r.int(200) - 100) / 1000) * 1e4) / 1e4,
    }));
  });

/** Orders hold 1 to 4 tickets. Sizes repeat in cycles of 20 tickets, so any ticket finds its order in O(1). */
function orderOf(x: Ctx, index: number): { order: number; pos: number } {
  const cycle = Math.floor((index - 1) / 20);
  let left = (index - 1) % 20;
  const sizes = new Rng(`${x.c.seed}|${x.c.dataset}|orders|${cycle}`).shuffle([
    1, 1, 2, 2, 3, 3, 4, 4,
  ]);
  for (let j = 0; j < sizes.length; j++) {
    const size = sizes[j] as number;
    if (left < size) return { order: cycle * 8 + j + 1, pos: left };
    left -= size;
  }
  return { order: cycle * 8 + 8, pos: 0 };
}

export const eventTickets: DatasetDef = {
  prefix: 't-',
  pad: 4,
  pageSize: 50,
  fields: {
    ...PERSON_FIELDS,
    ticketId: S,
    orderRef: S,
    attendee: S,
    eventName: S,
    venueName: S,
    venueRegion: S,
    venueRoom: S,
    seat: S,
    admission: S,
    ticketType: S,
    startsAt: D,
    doorsAt: D,
    endsAt: D,
    venueTimeZone: S,
    venueLat: N,
    venueLng: N,
    gate: S,
    status: S,
  },
  bad: ['attendee', 'ticketId'],
  build(x, index, r) {
    const { order, pos } = orderOf(x, index);
    const or = new Rng(`${x.c.seed}|${x.c.dataset}|${x.c.locale}|order|${order}`);
    const buyer = makePerson(x, or, order);
    const ev = events(x)[or.int(events(x).length)] as Event;
    // Seats come from a bijection of the ticket number, so they are unique across every event.
    const p = ((index - 1) * 421 + 17) % 1024;
    const ticketType = r.pick(['Standard', 'Standard', 'VIP', 'Early bird']);
    const at = (ms: number) => isoWall(ms, x.zone.offset);
    return {
      holderEmail: buyer.email,
      record: {
        ...personFields(buyer),
        ticketId: `TK-${scatter(index, 100000, 900000)}`,
        orderRef: `O-${scatter(order, 100000, 900000)}`,
        attendee: pos === 0 ? fullName(buyer) : `${r.pick(x.words.first)} ${buyer.lastName}`,
        eventName: ev.name,
        venueName: ev.venue,
        venueRegion: ev.region,
        venueRoom: `Section ${'ABCDEFGH'[p >> 7]}`,
        seat: `R${((p >> 4) & 7) + 1}-S${(p & 15) + 1}`,
        admission: ticketType === 'VIP' ? 'VIP lounge' : 'Reserved seat',
        ticketType,
        startsAt: at(ev.start),
        doorsAt: at(ev.start - HOUR),
        endsAt: at(ev.start + 3 * HOUR),
        venueTimeZone: x.zone.tz,
        venueLat: ev.lat,
        venueLng: ev.lng,
        gate: r.pick(GATES),
        status: 'valid',
      },
    };
  },
  change(_x, _i, record, r) {
    record.status = r.chance(70) ? 'valid' : (r.pick(STATUS.slice(1)) as string);
    record.gate = r.pick(GATES);
  },
};
