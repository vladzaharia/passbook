import type { AccessManifest, AccessPlan, WeeklyHours } from '../../types.ts';
import { closesAt, endOfDay, nextOpen, openAll } from './hours.ts';

/** One of the org's zones, as the evaluator needs it. */
export interface ZoneNode {
  id: string;
  key: string;
  name: string;
  parentId: string | null;
  /** Roots only. */
  timeZone: string | null;
  archived: boolean;
}

export interface DecideInput {
  access: AccessManifest;
  /** The pass's inputs after defaults. */
  inputs: Record<string, unknown>;
  createdAt: number;
  now: number;
  /** Every zone of the org, archived ones included. */
  zones: ZoneNode[];
  /** The zones the session checks, in its order. Empty: any zone the pass opens. */
  scannerZoneIds: string[];
  /** The session's clock, used when no zone has one. */
  timeZone: string;
}

export type AccessRefusal =
  | 'suspended'
  | 'not_yet_valid'
  | 'guest_expired'
  | 'zone_not_included'
  | 'outside_hours';

export interface AccessDecision {
  allowed: boolean;
  reason: AccessRefusal | null;
  /** `not_yet_valid`: when it opens. `guest_expired`: when it ended. */
  at: number | null;
  /** The pass names a plan its template no longer has. */
  planUnknown: boolean;
  /** The guest's visit limit; the gate enforces it. */
  visitLimit: number | null;
  access: {
    plan: { id: string; label: string; kind: AccessPlan['kind'] };
    zone: { id: string; name: string } | null;
    closesAt: number | null;
    nextOpenAt: number | null;
    timeZone: string;
  };
}

interface Grant {
  key: string;
  hours?: WeeklyHours;
}

const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

function time(v: unknown): number | null {
  const t = typeof v === 'string' ? Date.parse(v) : Number.NaN;
  return Number.isNaN(t) ? null : t;
}

/** The plan's grants plus the pass's add-on zones (which follow the plan's hours only). */
export function resolveGrants(
  access: AccessManifest,
  plan: AccessPlan,
  inputs: Record<string, unknown>,
): Grant[] {
  const out: Grant[] = [];
  for (const g of plan.zones) {
    const key = typeof g.zone === 'string' ? g.zone : text(inputs[g.zone.input]);
    if (key !== null) out.push(g.hours ? { key, hours: g.hours } : { key });
  }
  const extra = access.input.zones === undefined ? undefined : inputs[access.input.zones];
  const keys = Array.isArray(extra) ? extra : [extra];
  for (const k of keys) {
    const key = text(k);
    if (key !== null) out.push({ key });
  }
  return out;
}

/** The grants that apply at a zone: the nearest level of it and its ancestors that has one, else `*`. */
export function grantFor(chain: ZoneNode[], grants: Grant[]): Grant[] {
  for (const node of chain) {
    const found = grants.filter((g) => g.key === node.key);
    if (found.length > 0) return found;
  }
  return grants.filter((g) => g.key === '*');
}

/** A zone's own clock, else its nearest ancestor's, else the fallback. */
export function tzOf(chain: ZoneNode[], fallback: string): string {
  for (const node of chain) if (node.timeZone) return node.timeZone;
  return fallback;
}

/** The zone, then its ancestors up to the root. */
function chainOf(zone: ZoneNode, byId: Map<string, ZoneNode>): ZoneNode[] {
  const chain = [zone];
  let at: ZoneNode | undefined = zone;
  while (at?.parentId && chain.length < 8) {
    at = byId.get(at.parentId);
    if (at) chain.push(at);
  }
  return chain;
}

/** The suspend rule: the input's value is one of `equals`. */
export function suspended(access: AccessManifest, inputs: Record<string, unknown>): boolean {
  if (!access.suspend) return false;
  const v = inputs[access.suspend.input];
  return (
    (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') &&
    access.suspend.equals.includes(String(v))
  );
}

/** A guest's visit limit: the pass's own, else the plan's, else none. */
export function visitLimit(
  access: AccessManifest,
  plan: AccessPlan,
  inputs: Record<string, unknown>,
): number | null {
  if (plan.kind !== 'guest') return null;
  const own = access.input.visits === undefined ? undefined : inputs[access.input.visits];
  if (typeof own === 'number' && Number.isInteger(own) && own >= 1) return own;
  return plan.visits ?? null;
}

/** A guest's end: the pass's own, else local midnight `days` after the start day. */
export function guestUntil(
  access: AccessManifest,
  plan: AccessPlan,
  inputs: Record<string, unknown>,
  createdAt: number,
  timeZone: string,
): number {
  const own = access.input.until === undefined ? null : time(inputs[access.input.until]);
  if (own !== null) return own;
  const from = access.input.from === undefined ? null : time(inputs[access.input.from]);
  return endOfDay(from ?? createdAt, timeZone, plan.days ?? 1);
}

interface Place {
  zone: ZoneNode | null;
  tz: string;
  options: Grant[];
}

/** Steps 10a-10e of the scan order: suspend, start, guest end, zones, hours. */
export function decide(input: DecideInput): AccessDecision {
  const { access, inputs, now } = input;
  const planId = text(inputs[access.input.plan]);
  const plan = access.plans.find((p) => p.id === planId);
  const stub = plan
    ? { id: plan.id, label: plan.label, kind: plan.kind }
    : { id: planId ?? '', label: planId ?? '', kind: 'always' as const };
  const base: AccessDecision = {
    allowed: false,
    reason: null,
    at: null,
    planUnknown: plan === undefined,
    visitLimit: plan ? visitLimit(access, plan, inputs) : null,
    access: { plan: stub, zone: null, closesAt: null, nextOpenAt: null, timeZone: input.timeZone },
  };
  const refuse = (reason: AccessRefusal, patch: Partial<AccessDecision> = {}): AccessDecision => ({
    ...base,
    ...patch,
    reason,
  });

  if (suspended(access, inputs)) return refuse('suspended');
  if (!plan) return refuse('zone_not_included');

  const byId = new Map(input.zones.map((z) => [z.id, z]));
  const checked = input.scannerZoneIds.flatMap((id) => byId.get(id) ?? []);
  const first = checked[0];
  const clock = first ? tzOf(chainOf(first, byId), input.timeZone) : input.timeZone;
  base.access.timeZone = clock;

  const from = access.input.from === undefined ? null : time(inputs[access.input.from]);
  if (from !== null && from > now) return refuse('not_yet_valid', { at: from });

  const until =
    plan.kind === 'guest'
      ? guestUntil(access, plan, inputs, input.createdAt, clock)
      : access.input.until === undefined
        ? null
        : time(inputs[access.input.until]);
  if (plan.kind === 'guest' && until !== null && now >= until)
    return refuse('guest_expired', { at: until });

  const grants = resolveGrants(access, plan, inputs);
  const active = (z: ZoneNode) => chainOf(z, byId).every((n) => !n.archived);
  const places: Place[] = [];
  const addPlace = (zone: ZoneNode) => {
    const chain = chainOf(zone, byId);
    const options = grantFor(chain, grants);
    if (options.length > 0) places.push({ zone, tz: tzOf(chain, input.timeZone), options });
  };
  if (input.scannerZoneIds.length > 0) {
    for (const z of checked) if (active(z)) addPlace(z);
  } else {
    for (const z of input.zones) if (active(z)) addPlace(z);
    const any = grants.filter((g) => g.key === '*');
    if (any.length > 0) places.push({ zone: null, tz: input.timeZone, options: any });
  }
  const named = (z: ZoneNode | null) =>
    input.scannerZoneIds.length > 0 && z ? { id: z.id, name: z.name } : null;

  if (places.length === 0)
    return refuse('zone_not_included', {
      access: { ...base.access, zone: first ? { id: first.id, name: first.name } : null },
    });

  const schedules = (p: Place) =>
    p.options.map((o) => [plan.kind === 'always' ? undefined : plan.hours, o.hours]);
  const opens = (p: Place, t: number) => schedules(p).some((s) => openAll(s, p.tz, t));
  const open = places.find((p) => opens(p, now));
  if (open) {
    const closes = schedules(open)
      .filter((s) => openAll(s, open.tz, now))
      .map((s) => closesAt(s, open.tz, now));
    const hoursEnd = closes.includes(null) ? null : Math.max(...(closes as number[]));
    const ends = [hoursEnd, until].filter((t): t is number => t !== null);
    return {
      ...base,
      allowed: true,
      access: {
        ...base.access,
        zone: named(open.zone),
        closesAt: ends.length > 0 ? Math.min(...ends) : null,
        timeZone: open.tz,
      },
    };
  }

  let soonest = places[0] as Place;
  let soonestAt: number | null = null;
  for (const p of places) {
    for (const s of schedules(p)) {
      const t = nextOpen(s, p.tz, now);
      if (t !== null && (soonestAt === null || t < soonestAt)) {
        soonestAt = t;
        soonest = p;
      }
    }
  }
  return refuse('outside_hours', {
    access: {
      ...base.access,
      zone: named(soonest.zone),
      nextOpenAt: soonestAt !== null && until !== null && soonestAt >= until ? null : soonestAt,
      timeZone: soonest.tz,
    },
  });
}
