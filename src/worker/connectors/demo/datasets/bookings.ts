import { fullName, makePerson } from '../people.ts';
import { DAY, HOUR, isoWall, MIN, memo, scatter, worldKey, worldRng } from '../world.ts';
import { D, type DatasetDef, PERSON_FIELDS, personFields, S } from './types.ts';

const SERVICES: Record<string, readonly string[]> = {
  'en-US': ['Haircut', 'Massage', 'Consultation', 'Fitting', 'Check-up', 'Lesson'],
  'en-GB': ['Haircut', 'Massage', 'Consultation', 'Fitting', 'Check-up', 'Lesson'],
  'de-DE': ['Haarschnitt', 'Massage', 'Beratung', 'Anprobe', 'Kontrolle', 'Unterricht'],
  'fr-FR': ['Coupe', 'Massage', 'Consultation', 'Essayage', 'Contrôle', 'Cours'],
  'es-ES': ['Corte', 'Masaje', 'Consulta', 'Prueba', 'Revisión', 'Clase'],
};
const STAFF = 6;
const SLOTS = 8;
/** 9:00 to 16:00; every slot is 60 minutes and a booking takes 30, so a move of 30 stays inside it. */
const START_HOUR = 9;

const world = (x: Parameters<DatasetDef['build']>[0]) =>
  memo(worldKey(x.c), () => {
    const r = worldRng(x.c);
    const places = Array.from(
      { length: 3 },
      () => `${r.pick(x.words.city)} ${r.pick(['Studio', 'Clinic', 'Salon'])}`,
    );
    const staff = Array.from({ length: STAFF }, (_, i) => fullName(makePerson(x, r, i + 1)));
    return { places, staff };
  });

export const bookings: DatasetDef = {
  prefix: 'b-',
  pad: 4,
  pageSize: 50,
  fields: {
    ...PERSON_FIELDS,
    bookingRef: S,
    name: S,
    what: S,
    where: S,
    with: S,
    startsAt: D,
    endsAt: D,
    status: S,
  },
  bad: ['name', 'bookingRef'],
  build(x, index, r) {
    const p = makePerson(x, r, index);
    const w = world(x);
    // Staff rotate and each one's n-th booking takes the n-th slot, so nobody is double-booked.
    const staff = (index - 1) % STAFF;
    const n = Math.floor((index - 1) / STAFF);
    const day = Math.floor(n / SLOTS);
    // Start on the Monday after the anchor, then count weekdays.
    const monday = x.t0 + ((8 - new Date(x.t0).getUTCDay()) % 7 || 7) * DAY;
    const date = monday + (Math.floor(day / 5) * 7 + (day % 5)) * DAY;
    const start = date + (START_HOUR + (n % SLOTS)) * HOUR;
    const off = x.zone.offset;
    return {
      holderEmail: p.email,
      record: {
        ...personFields(p),
        bookingRef: `BK-${scatter(index, 100000, 900000)}`,
        name: fullName(p),
        what: r.pick(SERVICES[x.c.locale] ?? SERVICES['en-US'] ?? []),
        where: w.places[staff % w.places.length] as string,
        with: w.staff[staff] as string,
        startsAt: isoWall(start, off),
        endsAt: isoWall(start + 30 * MIN, off),
        status: 'Booked',
      },
    };
  },
  change(x, _i, record, r) {
    const roll = r.int(100);
    const off = x.zone.offset;
    if (roll < 25) {
      record.status = 'Cancelled';
    } else if (roll < 65) {
      // Moved by 30 minutes, inside its own 60-minute slot.
      const start = Date.parse(String(record.startsAt)) + 30 * MIN;
      record.status = 'Moved';
      record.startsAt = isoWall(start + off * HOUR, off);
      record.endsAt = isoWall(start + 30 * MIN + off * HOUR, off);
    } else {
      record.status = 'Booked';
    }
  },
};
