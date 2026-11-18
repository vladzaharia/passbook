// Pure retention policy. No I/O: every rule that decides how long data lives is a function here, with a test table.
// Deletion is never early: whatever cannot be resolved to a valid number of days resolves to "skip".
import {
  DATA_CLASSES,
  isValidDays,
  type RetentionClass,
} from '../../../shared/privacy/data-classes.ts';

export const DAY = 86_400_000;
/** A shortened retention keeps the old days this long. */
export const FLOOR_DELAY_DAYS = 7;
/** Orgs with their own value that one class sweeps per day. */
export const SPECIAL_ORGS_PER_DAY = 25;

/** `undefined` is an absent setting; anything else is the stored value, valid or not. */
export type Raw = unknown;

export type PlatformPolicy =
  | { ok: true; defaultDays: number; maxDays: number }
  | { ok: false; reason: 'platform_invalid' };

/**
 * The platform default (clamped to the maximum) and maximum. An absent value is the table default; a stored
 * value that is not a whole number of days inside the class bounds blocks the class for every org.
 */
export function resolvePlatform(cls: RetentionClass, rawDefault: Raw, rawMax: Raw): PlatformPolicy {
  const c = DATA_CLASSES[cls];
  const def = rawDefault === undefined ? c.platformDefault : rawDefault;
  const max = rawMax === undefined ? c.platformMax : rawMax;
  if (!isValidDays(cls, def) || !isValidDays(cls, max))
    return { ok: false, reason: 'platform_invalid' };
  return { ok: true, defaultDays: Math.min(def, max), maxDays: max };
}

export interface ActiveFloor {
  days: number;
  until: number;
}

export type OrgDecision =
  | {
      kind: 'run';
      days: number;
      source: 'org' | 'platform';
      /** A floor holds the old, longer value until `pendingShorterFrom`. */
      pendingShorterFrom?: number;
    }
  | { kind: 'skip'; reason: 'invalid' | 'hold' };

export interface OrgInput {
  cls: RetentionClass;
  platform: Extract<PlatformPolicy, { ok: true }>;
  orgRaw: Raw;
  floor: ActiveFloor | null;
  held: boolean;
  now: number;
}

/**
 * clamp(org ?? platform default, class floor, platform max), raised by an unexpired floor, skipped under a hold.
 * An invalid stored value skips; it never falls back to the platform default.
 */
export function resolveOrg(i: OrgInput): OrgDecision {
  if (i.orgRaw !== undefined && !isValidDays(i.cls, i.orgRaw))
    return { kind: 'skip', reason: 'invalid' };
  if (i.held) return { kind: 'skip', reason: 'hold' };
  const configured = clampDays(i.cls, i.orgRaw ?? i.platform.defaultDays, i.platform.maxDays);
  const source = i.orgRaw === undefined ? 'platform' : 'org';
  if (i.floor && i.floor.until > i.now && i.floor.days > configured)
    return { kind: 'run', days: i.floor.days, source, pendingShorterFrom: i.floor.until };
  return { kind: 'run', days: configured, source };
}

export function clampDays(cls: RetentionClass, days: number, maxDays: number): number {
  return Math.max(DATA_CLASSES[cls].floor, Math.min(days, maxDays));
}

export interface OrgRow {
  orgId: string;
  raw: Raw;
  floor: ActiveFloor | null;
  held: boolean;
}

export interface OrgCutoff {
  orgId: string;
  days: number;
  cutoff: number;
}

export type RetentionPlan =
  | { blocked: true; cls: RetentionClass; reason: 'platform_invalid' }
  | {
      blocked: false;
      cls: RetentionClass;
      platformDays: number;
      platformCutoff: number;
      /** Orgs whose effective days differ from the platform's. */
      special: OrgCutoff[];
      /** Orgs on hold or with an invalid value: nothing is deleted for them. */
      skipped: { orgId: string; reason: 'invalid' | 'hold' }[];
    };

/** `orgs` lists every org that has its own value, an unexpired floor or an org-wide hold; the rest follow the platform. */
export function buildPlan(
  cls: RetentionClass,
  platform: PlatformPolicy,
  orgs: readonly OrgRow[],
  now: number,
): RetentionPlan {
  if (!platform.ok) return { blocked: true, cls, reason: platform.reason };
  const special: OrgCutoff[] = [];
  const skipped: { orgId: string; reason: 'invalid' | 'hold' }[] = [];
  for (const o of orgs) {
    const d = resolveOrg({ cls, platform, orgRaw: o.raw, floor: o.floor, held: o.held, now });
    if (d.kind === 'skip') skipped.push({ orgId: o.orgId, reason: d.reason });
    else if (d.days !== platform.defaultDays)
      special.push({ orgId: o.orgId, days: d.days, cutoff: now - d.days * DAY });
  }
  special.sort((a, b) => (a.orgId < b.orgId ? -1 : 1));
  skipped.sort((a, b) => (a.orgId < b.orgId ? -1 : 1));
  return {
    blocked: false,
    cls,
    platformDays: platform.defaultDays,
    platformCutoff: now - platform.defaultDays * DAY,
    special,
    skipped,
  };
}

/** Org ids the platform pass must leave alone: special orgs have their own pass, skipped ones none. */
export function excludedFromPlatformPass(
  plan: Extract<RetentionPlan, { blocked: false }>,
): string[] {
  return [...plan.special.map((o) => o.orgId), ...plan.skipped.map((o) => o.orgId)].sort();
}

/** The next orgs after `cursor` in id order, wrapping. An org not reached waits a day: late, never early. */
export function nextBatch(
  special: readonly OrgCutoff[],
  cursor: string | null,
  limit = SPECIAL_ORGS_PER_DAY,
): { batch: OrgCutoff[]; cursor: string | null } {
  if (special.length === 0) return { batch: [], cursor: null };
  const sorted = [...special].sort((a, b) => (a.orgId < b.orgId ? -1 : 1));
  const start = cursor === null ? 0 : sorted.findIndex((o) => o.orgId > cursor);
  const from = start === -1 ? 0 : start;
  const batch = [...sorted.slice(from), ...sorted.slice(0, from)].slice(0, limit);
  return { batch, cursor: batch.length < sorted.length ? (batch.at(-1)?.orgId ?? null) : null };
}

export type FloorChange = { kind: 'set'; days: number; until: number } | { kind: 'clear' };

/**
 * `before` is the effective days now (a floor included), `after` what the save configures. Shorter keeps the
 * old days for 7 days; the same or longer drops any floor, because the new value already covers it.
 */
export function floorChange(before: number, after: number, now: number): FloorChange {
  return after < before
    ? { kind: 'set', days: before, until: now + FLOOR_DELAY_DAYS * DAY }
    : { kind: 'clear' };
}

export type HoldKind = 'org' | 'platform';

/** An org admin releases org-placed holds only; a platform admin releases any. */
export function canRelease(placedBy: HoldKind, releasedBy: HoldKind): boolean {
  return releasedBy === 'platform' || placedBy === 'org';
}
