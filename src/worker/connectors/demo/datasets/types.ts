import type { ConnectorOutputField, UpstreamRecord } from '../../types.ts';
import type { Person } from '../people.ts';
import type { Rng } from '../prng.ts';
import type { Ctx } from '../world.ts';

export interface Built {
  record: UpstreamRecord;
  holderEmail: string;
}

export interface DatasetDef {
  /** Refs are `<prefix><n padded to pad>`. */
  prefix: string;
  pad: number;
  pageSize: number;
  fields: Record<string, ConnectorOutputField>;
  /** Fields emptied by the bad_records failure, so template validation rejects the record. */
  bad: readonly string[];
  /** The record as first issued (index is 1-based). `r` is this record's own stream. */
  build(x: Ctx, index: number, r: Rng): Built;
  /** Applies one upstream change in place; `r` is seeded by the record and its last change step `last`; counters grow with `last`, never shrink. */
  change(x: Ctx, index: number, record: UpstreamRecord, r: Rng, last: number): void;
}

const f = (type: ConnectorOutputField['type']) => ({ type }) as const;
export const S = f('string');
export const N = f('number');
export const B = f('boolean');
export const D = f('date');

/** The person set every v2 dataset carries (photos are initials only). */
export const PERSON_FIELDS = {
  firstName: S,
  lastName: S,
  email: S,
  phone: S,
  birthday: D,
  initials: S,
  avatarColor: S,
  updatedAt: D,
} as const;

export function personFields(p: Person): UpstreamRecord {
  return {
    firstName: p.firstName,
    lastName: p.lastName,
    email: p.email,
    phone: p.phone,
    birthday: p.birthday,
    address: p.address,
    initials: p.initials,
    avatarColor: p.avatarColor,
  };
}
