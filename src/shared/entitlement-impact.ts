import {
  ENTITLEMENT_KEYS,
  type EntitlementKey,
  type EntitlementValue,
  entitlementDef,
  parseEntitlementValue,
} from './contracts/entitlements.ts';

/** Resolved values by key; a key not here is not entitled. */
export type EntitlementValues = Partial<Record<EntitlementKey, EntitlementValue>>;

/**
 * What a change does to one feature, from the org's side: `off` and `on` for a feature that stops or starts,
 * `down` and `up` for a smaller or larger share of it (a lower limit, a lower level, a shorter allow-list),
 * `changed` when neither reads as more.
 */
export type ImpactKind = 'off' | 'down' | 'on' | 'up' | 'changed';

export interface ImpactChange {
  key: EntitlementKey;
  from: EntitlementValue | undefined;
  to: EntitlementValue | undefined;
  kind: ImpactKind;
}

export interface EntitlementImpact {
  changes: ImpactChange[];
  /** Counts by kind; `unchanged` is the features that stay as they are. */
  counts: Record<ImpactKind, number> & { unchanged: number };
}

/** The PassBook mark is the one level that reads backwards: less of it is more for the org. */
const REVERSED = new Set<EntitlementKey>(['brand.mark']);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function levelKind(key: EntitlementKey, from: string, to: string): ImpactKind {
  const def = entitlementDef(key);
  if (def.kind !== 'level') return 'changed';
  const a = def.levels.indexOf(from);
  const b = def.levels.indexOf(to);
  if (a < 0 || b < 0 || a === b) return 'changed';
  const lower = REVERSED.has(key) ? b > a : b < a;
  // A level named `off` is a switch: reaching or leaving it starts or stops the feature.
  if (def.levels[0] === 'off' && !REVERSED.has(key)) {
    if (b === 0) return 'off';
    if (a === 0) return 'on';
  }
  return lower ? 'down' : 'up';
}

function limitKind(from: number | null, to: number | null): ImpactKind {
  if (from === to) return 'changed';
  if (to === 0) return 'off';
  if (from === 0) return 'on';
  if (to === null) return 'up';
  if (from === null) return 'down';
  return to < from ? 'down' : 'up';
}

/** A shorter connector allow-list stops new connections only: existing REST connections keep running. */
function listKind(key: EntitlementKey, from: string[], to: string[]): ImpactKind {
  const def = entitlementDef(key);
  if (def.kind !== 'list') return 'changed';
  // `*` is the whole set: gaining it gives the org everything an allow-list can name, and a block-list blocks all.
  if (from.includes('*') !== to.includes('*'))
    return from.includes('*') !== def.block ? 'down' : 'up';
  const gone = from.filter((e) => !to.includes(e)).length;
  const added = to.filter((e) => !from.includes(e)).length;
  if (gone === 0 && added === 0) return 'changed';
  if (gone > 0 && added > 0) return 'changed';
  // An allow-list that grows or a block-list that shrinks gives the org more.
  const more = def.block ? gone > 0 : added > 0;
  return more ? 'up' : 'down';
}

function kindOf(
  key: EntitlementKey,
  from: EntitlementValue | undefined,
  to: EntitlementValue | undefined,
): ImpactKind {
  // A missing or invalid value denies, so it reads as the feature being off.
  const a = from === undefined ? undefined : parseEntitlementValue(key, from);
  const b = to === undefined ? undefined : parseEntitlementValue(key, to);
  const def = entitlementDef(key);
  if (a === undefined || b === undefined) return a === undefined ? 'on' : 'off';
  switch (def.kind) {
    case 'flag':
      return b === 0 ? 'off' : 'on';
    case 'level':
      return levelKind(key, a as string, b as string);
    case 'limit':
      return limitKind(a as number | null, b as number | null);
    case 'list':
      return listKind(key, a as string[], b as string[]);
  }
}

/** Every feature whose resolved value differs between `before` and `after`, in registry order, with counts. */
export function entitlementImpact(
  before: EntitlementValues,
  after: EntitlementValues,
): EntitlementImpact {
  const counts = { off: 0, down: 0, on: 0, up: 0, changed: 0, unchanged: 0 };
  const changes: ImpactChange[] = [];
  for (const key of ENTITLEMENT_KEYS) {
    if (same(before[key], after[key])) {
      counts.unchanged += 1;
      continue;
    }
    const kind = kindOf(key, before[key], after[key]);
    counts[kind] += 1;
    changes.push({ key, from: before[key], to: after[key], kind });
  }
  return { changes, counts };
}

/** What stops or shrinks: the part of an impact an admin must weigh before applying it. */
export const reducing = (impact: EntitlementImpact): number =>
  impact.counts.off + impact.counts.down;
