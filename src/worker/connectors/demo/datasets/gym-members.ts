import { makePerson } from '../people.ts';
import { DAY, isoDate, isoWall, memo, scatter, worldKey, worldRng } from '../world.ts';
import { B, D, type DatasetDef, N, PERSON_FIELDS, personFields, S } from './types.ts';

const PLANS = ['member', 'member', 'member', 'off_peak', 'guest'] as const;
const RENEW = { member: 30, off_peak: 30, guest: 7 } as const;
const TIERS = ['Bronze', 'Silver', 'Gold', 'Platinum'] as const;

const clubs = (x: Parameters<DatasetDef['build']>[0]) =>
  memo(worldKey(x.c), () => {
    const r = worldRng(x.c);
    return Array.from(
      { length: r.range(2, 4) },
      () => `${r.pick(x.words.city)} ${r.pick(['Central', 'Riverside', 'Harbor', 'Park'])}`,
    );
  });

export const gymMembers: DatasetDef = {
  prefix: 'm-',
  pad: 3,
  pageSize: 50,
  fields: {
    ...PERSON_FIELDS,
    memberName: S,
    memberId: S,
    status: S,
    plan: S,
    tier: S,
    points: N,
    visits: N,
    guests: N,
    homeClub: S,
    joinedAt: D,
    validFrom: D,
    validUntil: D,
    active: B,
  },
  bad: ['memberName', 'memberId'],
  build(x, index, r) {
    const p = makePerson(x, r, index);
    const plan = r.pick(PLANS);
    const validFrom = x.t0 - r.range(0, 27) * DAY;
    const record = {
      ...personFields(p),
      memberName: `${p.firstName} ${p.lastName}`,
      memberId: `M-${scatter(index, 100000, 900000)}`,
      status: r.chance(8) ? 'Suspended' : 'Active',
      plan,
      tier: r.pick(TIERS),
      points: r.range(0, 5000),
      visits: r.range(0, 300),
      guests: r.range(0, 5),
      homeClub: r.pick(clubs(x)),
      joinedAt: isoDate(x.t0 - r.range(30, 1500) * DAY),
      validFrom: isoWall(validFrom, x.zone.offset),
      validUntil: isoWall(validFrom + RENEW[plan] * DAY, x.zone.offset),
    };
    return { record: { ...record, active: record.status === 'Active' }, holderEmail: p.email };
  },
  change(_x, _i, record, r, last) {
    // `last * 40 + 0..39` rises with every later change step, so a counter never goes back.
    record.points = Number(record.points) + last * 40 + r.int(40);
    record.visits = Number(record.visits) + last * 2 + r.int(2);
    record.status = record.status === 'Active' && r.chance(30) ? 'Suspended' : 'Active';
    record.active = record.status === 'Active';
    if (r.chance(25)) record.tier = r.pick(TIERS);
  },
};
