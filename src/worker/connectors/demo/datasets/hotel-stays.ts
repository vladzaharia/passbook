import { fullName, makePerson } from '../people.ts';
import { DAY, HOUR, isoWall, memo, scatter, title, worldKey, worldRng } from '../world.ts';
import { D, type DatasetDef, N, PERSON_FIELDS, personFields, S } from './types.ts';

/** 3 floors of 10 rooms. */
const ROOMS = Array.from(
  { length: 30 },
  (_, i) => `${Math.floor(i / 10) + 1}${String((i % 10) + 1).padStart(2, '0')}`,
);
/** A room's stays sit in back-to-back 6-day slots: check-in on day 0 to 2, at most 3 nights. */
const SLOT_DAYS = 6;
const included = (yes: boolean) => (yes ? 'Included' : 'Not included');
const TIERS = ['Member', 'Silver', 'Gold', 'Platinum'] as const;

const hotel = (x: Parameters<DatasetDef['build']>[0]) =>
  memo(worldKey(x.c), () => {
    const r = worldRng(x.c);
    return `${title(r.pick(x.words.adjective))} ${title(r.pick(x.words.noun))}`.replace(/\s/g, '');
  });

export const hotelStays: DatasetDef = {
  prefix: 'r-',
  pad: 4,
  pageSize: 50,
  fields: {
    ...PERSON_FIELDS,
    guest: S,
    reservation: S,
    checkIn: D,
    nights: N,
    checkOut: D,
    room: S,
    breakfast: S,
    spa: S,
    plate: S,
    wifiNetwork: S,
    wifiPassword: S,
    loyaltyTier: S,
    status: S,
  },
  bad: ['guest', 'reservation'],
  build(x, index, r) {
    const p = makePerson(x, r, index);
    // Rooms rotate, so a room's n-th stay lands in its n-th slot: no room is ever double-booked.
    const room = ROOMS[(index - 1) % ROOMS.length] as string;
    const slot = Math.floor((index - 1) / ROOMS.length);
    const nights = r.range(1, 3);
    const day = x.t0 + (slot * SLOT_DAYS + r.range(0, 2)) * DAY;
    const off = x.zone.offset;
    return {
      holderEmail: p.email,
      record: {
        ...personFields(p),
        guest: fullName(p),
        reservation: `RES-${scatter(index, 100000, 900000)}`,
        checkIn: isoWall(day + 15 * HOUR, off),
        nights,
        checkOut: isoWall(day + nights * DAY + 11 * HOUR, off),
        room,
        breakfast: included(r.chance(50)),
        spa: included(r.chance(25)),
        plate: r.pattern('???-####'),
        wifiNetwork: `${hotel(x)}-Guest`,
        wifiPassword: `${r.pick(x.words.adjective)} ${r.pick(x.words.noun)} ${r.range(10, 99)}`,
        loyaltyTier: r.pick(TIERS),
        status: 'Confirmed',
      },
    };
  },
  change(_x, _i, record, r) {
    record.breakfast = included(r.chance(50));
    record.spa = included(r.chance(30));
    record.status = r.chance(85) ? 'Confirmed' : 'Cancelled';
  },
};
