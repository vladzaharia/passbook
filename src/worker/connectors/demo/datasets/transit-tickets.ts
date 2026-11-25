import { fullName, makePerson } from '../people.ts';
import { DAY, HOUR, isoWall, MIN, memo, scatter, title, worldKey, worldRng } from '../world.ts';
import { D, type DatasetDef, N, PERSON_FIELDS, personFields, S } from './types.ts';

const MODES = ['boat', 'bus', 'train'] as const;
const STATUS = ['On time', 'Delayed', 'Cancelled'] as const;
const SLOTS = 8;

const routes = (x: Parameters<DatasetDef['build']>[0]) =>
  memo(worldKey(x.c), () => {
    const r = worldRng(x.c);
    return MODES.map((mode, i) => {
      const from = r.pick(x.words.city);
      let to = r.pick(x.words.city);
      while (to === from) to = r.pick(x.words.city);
      const name =
        mode === 'boat' ? `MV ${title(r.pick(x.words.noun))}` : `${title(mode)} ${r.range(10, 99)}`;
      return { mode, from, to, name, key: `${mode.charAt(0).toUpperCase()}${i + 1}` };
    });
  });

export const transitTickets: DatasetDef = {
  prefix: 'x-',
  pad: 4,
  pageSize: 50,
  fields: {
    ...PERSON_FIELDS,
    mode: S,
    origin: S,
    originTimeZone: S,
    vehicleType: S,
    destination: S,
    departsAt: D,
    boardBy: D,
    serviceKey: S,
    status: S,
    vessel: S,
    lane: S,
    plate: S,
    name: S,
    bookingRef: S,
    adults: N,
    children: N,
    admits: N,
  },
  bad: ['name', 'bookingRef'],
  build(x, index, r) {
    const p = makePerson(x, r, index);
    const route = r.pick(routes(x));
    // Services run every 2 hours from 06:00, so many tickets share one departure.
    const day = r.range(1, 30);
    const slot = r.int(SLOTS);
    const depart = x.t0 + day * DAY + (6 + slot * 2) * HOUR;
    const off = x.zone.offset;
    const adults = r.range(1, 3);
    const children = r.range(0, 2);
    const hhmm = `${String(6 + slot * 2).padStart(2, '0')}00`;
    return {
      holderEmail: p.email,
      record: {
        ...personFields(p),
        mode: route.mode,
        origin: route.from,
        originTimeZone: x.zone.tz,
        vehicleType: route.mode === 'boat' ? r.pick(['Car', 'Van', 'Motorcycle', 'Bicycle']) : '',
        destination: route.to,
        departsAt: isoWall(depart, off),
        boardBy: isoWall(depart - 20 * MIN, off),
        serviceKey: `${route.key}-${new Date(depart).toISOString().slice(0, 10).replaceAll('-', '')}-${hhmm}`,
        status: r.chance(80) ? 'On time' : r.pick(STATUS.slice(1)),
        vessel: route.name,
        lane: route.mode === 'boat' ? `Lane ${r.range(1, 6)}` : '',
        plate: route.mode === 'boat' ? r.pattern('???-####') : '',
        name: fullName(p),
        bookingRef: `TR-${scatter(index, 100000, 900000)}`,
        adults,
        children,
        admits: adults + children,
      },
    };
  },
  change(_x, _i, record, r) {
    record.status = r.chance(40) ? 'On time' : r.pick(STATUS.slice(1));
    if (record.lane) record.lane = `Lane ${r.range(1, 6)}`;
  },
};
