import type { UpstreamRecord } from '../../types.ts';
import type { Config, DatasetId } from '../config.ts';
import { hash32, type Rng } from '../prng.ts';
import { ctxOf, recordRng, updatedAt } from '../world.ts';
import { boardingPasses } from './boarding-passes.ts';
import { bookings } from './bookings.ts';
import { eventTickets } from './event-tickets.ts';
import { gymMembers } from './gym-members.ts';
import { hotelStays } from './hotel-stays.ts';
import { loyaltyCards } from './loyalty-cards.ts';
import { staffBadges } from './staff-badges.ts';
import { transitTickets } from './transit-tickets.ts';
import type { Built, DatasetDef } from './types.ts';

export const DATASET_DEFS: Record<Exclude<DatasetId, 'classic'>, DatasetDef> = {
  'gym-members': gymMembers,
  'event-tickets': eventTickets,
  'hotel-stays': hotelStays,
  bookings,
  'boarding-passes': boardingPasses,
  'loyalty-cards': loyaltyCards,
  'staff-badges': staffBadges,
  'transit-tickets': transitTickets,
};

export const refOf = (def: DatasetDef, index: number) =>
  `${def.prefix}${String(index).padStart(def.pad, '0')}`;

/** The 1-based index a ref names, or null when the ref is not canonical. */
export function indexOf(def: DatasetDef, ref: string): number | null {
  if (!ref.startsWith(def.prefix)) return null;
  const n = Number(ref.slice(def.prefix.length));
  return Number.isInteger(n) && n > 0 && refOf(def, n) === ref ? n : null;
}

/** Highest revision step r <= revision at which this record changed; 0 when it never did. */
export function lastChange(c: Config, ref: string): number {
  if (c.changeRate === 0 || c.revision === 0) return 0;
  const floor = Math.max(1, c.revision - 499);
  for (let r = c.revision; r >= floor; r--) {
    if (hash32(`${c.seed}|${ref}|${r}`) % 100 < c.changeRate) return r;
  }
  return 0;
}

export function buildRecord(def: DatasetDef, c: Config, index: number): Built {
  const ref = refOf(def, index);
  const x = ctxOf(c);
  const built = def.build(x, index, recordRng(c, ref));
  const record: UpstreamRecord = built.record;
  const last = lastChange(c, ref);
  if (last > 0) def.change(x, index, record, recordRng(c, `${ref}|${last}`) as Rng);
  record.updatedAt = updatedAt(x, last);
  // One record in 20 is left unusable, so template validation has something to reject.
  if (c.fail === 'bad_records' && index % 20 === 0) for (const k of def.bad) record[k] = '';
  return { record, holderEmail: built.holderEmail };
}
