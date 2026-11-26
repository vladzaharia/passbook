import { fullName, makePerson } from '../people.ts';
import type { Rng } from '../prng.ts';
import { DAY, isoWall, memo, scatter, title, worldKey, worldRng } from '../world.ts';
import { D, type DatasetDef, PERSON_FIELDS, personFields, S } from './types.ts';

const TEAMS = [
  'Operations',
  'Engineering',
  'Facilities',
  'Security',
  'Finance',
  'Support',
] as const;
const ZONES = ['lobby', 'floor-2', 'floor-3', 'lab', 'warehouse', 'garage'] as const;
const zonesFor = (plan: unknown, r: Rng) =>
  r.shuffle(ZONES).slice(0, plan === 'contractor' ? 2 : r.range(2, 4));
const PLANS = ['staff', 'staff', 'staff', 'shift', 'contractor'] as const;
const VALID_DAYS = { staff: 365, shift: 30, contractor: 14 } as const;
const STATUS = ['Active', 'On leave', 'Suspended'] as const;

const company = (x: Parameters<DatasetDef['build']>[0]) =>
  memo(worldKey(x.c), () => {
    const r = worldRng(x.c);
    return `${title(r.pick(x.words.adjective))} ${title(r.pick(x.words.noun))} ${r.pick(['Works', 'Labs', 'Group', 'Systems'])}`;
  });

export const staffBadges: DatasetDef = {
  prefix: 's-',
  pad: 3,
  pageSize: 50,
  fields: {
    ...PERSON_FIELDS,
    memberName: S,
    memberId: S,
    company: S,
    team: S,
    plan: S,
    zones: S,
    validFrom: D,
    validUntil: D,
    status: S,
  },
  bad: ['memberName', 'memberId'],
  build(x, index, r) {
    const p = makePerson(x, r, index);
    const plan = r.pick(PLANS);
    const from = x.t0 - r.range(0, 30) * DAY;
    return {
      holderEmail: p.email,
      record: {
        ...personFields(p),
        memberName: fullName(p),
        memberId: `E-${scatter(index, 10000, 90000)}`,
        company: company(x),
        team: r.pick(TEAMS),
        plan,
        zones: zonesFor(plan, r),
        validFrom: isoWall(from, x.zone.offset),
        validUntil: isoWall(from + VALID_DAYS[plan] * DAY, x.zone.offset),
        status: r.chance(85) ? 'Active' : r.pick(STATUS.slice(1)),
      },
    };
  },
  change(_x, _i, record, r) {
    record.status = r.chance(70) ? 'Active' : r.pick(STATUS.slice(1));
    record.zones = zonesFor(record.plan, r);
  },
};
