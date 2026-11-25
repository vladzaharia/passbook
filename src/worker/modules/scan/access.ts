import {
  type AccessDecision,
  accessScope,
  decide,
  type ZoneNode,
} from '../../../passkit/template/access/index.ts';
import { applyDefaults } from '../../../passkit/template/manifest.ts';
import type { AccessManifest, AccessPlan, Json } from '../../../passkit/types.ts';
import type { ScanAccess } from '../../../shared/contracts/scan.ts';
import { DEFAULT_TIME_ZONE } from '../../../shared/time-zone.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { FoundAccess } from './access-types.ts';
import { scopeSessionId } from './actor.ts';
import type { ScanActor } from './guard.ts';
import { type PlaceRow, zoneRowsStmt } from './occupancy/repo-reads.ts';
import type { OccZone } from './occupancy/rules.ts';
import {
  accessGateReads,
  occZonesOf,
  orgZonesStmt,
  sessionZonesStmt,
  visitAtOf,
  type ZoneLink,
  zoneIdsOf,
  zoneNodes,
} from './repo-access.ts';
import type { Candidate } from './repo-lookup.ts';
import { orgTimeZoneOf, orgTimeZoneStmt } from './repo-org-clock.ts';
import { type ScanGateSnapshot, scanEffectFromResult } from './repo-scan-effect.ts';
import type { Found, Stop } from './resolve.ts';
import type { EvaluationReadPlan } from './resolve-evaluate.ts';
import { stop } from './resolve-policy.ts';
import { resolveCandidateReadTemplates } from './template-read-snapshot.ts';

const MINUTE = 60_000;
const DEFAULT_GAP_MINUTES = 120;

/** The plans of the template's current release (AX 2.1): null on every other template. */
export const accessManifestOf = (found: Found): AccessManifest | null =>
  found.activePolicy.manifest.scan?.access ?? null;

/**
 * A guest card past its end is `guest_expired`, not `expired` (AX 1.3): the end is also the pass's
 * own expiration, so the pass check sees it first. True when the candidate's plan is a guest plan.
 */
export function isGuestPass(candidate: Candidate): boolean {
  const templates = resolveCandidateReadTemplates(candidate);
  const access = templates?.active.manifest.scan?.access;
  if (!templates || !access) return false;
  const inputs = applyDefaults(templates.active.manifest, candidate.pass.personalization);
  return access.plans.find((p) => p.id === inputs[access.input.plan])?.kind === 'guest';
}

/** Zones for a scan at a door: read with the preflight, never cached (C5). */
interface LoadedAccess {
  zones: ZoneNode[];
  zoneIds: string[];
  gate: ScanGateSnapshot | null;
  visitAt: number | null;
  /** The same zones with their occupancy settings, and the pass's rows at them. */
  occupancy: { zones: OccZone[]; rows: PlaceRow[] };
  orgTimeZone: string;
}
export interface AccessReads extends EvaluationReadPlan {
  loaded(): LoadedAccess | null;
}

/** The reads an access decision needs. Event scanners need none: zones and hours do not apply there. */
export function planAccessReads(
  ctx: ServiceContext,
  actor: ScanActor,
  found: Found,
): AccessReads | null {
  if (!accessManifestOf(found) || actor.event) return null;
  const session = scopeSessionId(actor);
  const stmts = [
    orgZonesStmt(ctx.env.DB, actor.orgId),
    ...(session ? [sessionZonesStmt(ctx.env.DB, actor.orgId, session)] : []),
    ...accessGateReads(ctx.env.DB, found.pass.id),
    zoneRowsStmt(ctx.env.DB, actor.orgId, found.pass.id),
    orgTimeZoneStmt(ctx.env.DB, actor.orgId),
  ];
  let loaded: LoadedAccess | null = null;
  return {
    stmts,
    async finish(results) {
      if (results.length !== stmts.length) return;
      const at = session ? 2 : 1;
      loaded = {
        zones: zoneNodes(results[0]),
        zoneIds: session ? zoneIdsOf(results[1]) : [],
        gate: scanEffectFromResult(results[at]).gateBefore,
        visitAt: visitAtOf(results[at + 1]),
        occupancy: {
          zones: occZonesOf(results[0]),
          rows: (results[at + 2]?.results ?? []) as unknown as PlaceRow[],
        },
        orgTimeZone: orgTimeZoneOf(results[at + 3]),
      };
    },
    loaded: () => loaded,
  };
}

/** A read plan that runs another's statements and this one's, in one batch. */
export function joinReads(
  first: EvaluationReadPlan | undefined,
  second: EvaluationReadPlan | null,
): EvaluationReadPlan | undefined {
  if (!first) return second ?? undefined;
  if (!second) return first;
  return {
    stmts: [...first.stmts, ...second.stmts],
    async finish(results) {
      await first.finish(results.slice(0, first.stmts.length));
      await second.finish(results.slice(first.stmts.length));
    },
  };
}

/** The wire shape of a decision; `visits` and `visit` come from the gate once it has spoken. */
export function scanAccessOf(
  d: AccessDecision,
  gate: { visits: { used: number; limit: number | null } | null; visit: boolean } = {
    visits: null,
    visit: false,
  },
): ScanAccess {
  return { ...d.access, ...gate };
}

/** An event scanner asks only whether the pass is on hold, not started or ended: no zone, no hours. */
const anyZoneAnyHour = (p: AccessPlan): AccessPlan => ({
  id: p.id,
  label: p.label,
  kind: p.kind,
  zones: [{ zone: '*' }],
  ...(p.visits === undefined ? {} : { visits: p.visits }),
  ...(p.days === undefined ? {} : { days: p.days }),
});

/** The deciding zone, then its parents up to the root, as the decision read them. */
function chainOf(zoneId: string | null, zones: readonly ZoneNode[]): ZoneLink[] {
  const byId = new Map(zones.map((z) => [z.id, z]));
  const out: ZoneLink[] = [];
  for (let at = zoneId === null ? undefined : byId.get(zoneId); at && out.length < 8; ) {
    out.push({ id: at.id, parentId: at.parentId, key: at.key });
    at = at.parentId === null ? undefined : byId.get(at.parentId);
  }
  return out;
}

/** Refusals a Manager may let through. Suspended, voided, removed and expired stay final. */
const ACCESS_WAIVABLE = new Set<string>([
  'zone_not_included',
  'outside_hours',
  'guest_expired',
  'not_yet_valid',
]);
const ON_HOLD = new Set<AccessDecision['reason']>(['suspended', 'not_yet_valid', 'guest_expired']);

/**
 * Steps 10a-10e for a pass whose template is an Access card (AX 3.4). A refusal here is red and
 * final: it comes before the gate, so a suspended or ended pass never touches it. An event scanner
 * runs 10a-10c only: the pass is checked in once, whatever its zones or hours.
 */
export function accessStop(
  ctx: ServiceContext,
  actor: ScanActor,
  found: Found,
  known: Pick<Stop, 'pass' | 'ref' | 'found' | 'connectionGeneration'>,
  reads: AccessReads | null,
  now: number,
  waived?: string,
): Stop | null {
  const manifest = accessManifestOf(found);
  if (!manifest) return null;
  const event = actor.event !== null;
  const loaded = event
    ? {
        zones: [],
        zoneIds: [],
        gate: null,
        visitAt: null,
        occupancy: { zones: [], rows: [] },
        orgTimeZone: DEFAULT_TIME_ZONE,
      }
    : reads?.loaded();
  // The read did not land: nothing is let in on a guess.
  if (!loaded) return stop('refused', 'not_found', { stale: true });
  const inputs = applyDefaults(found.activePolicy.manifest, found.pass.personalization);
  const plans = event ? manifest.plans.map(anyZoneAnyHour) : manifest.plans;
  const d = decide({
    access: { ...manifest, plans },
    inputs,
    createdAt: found.pass.createdAt,
    now,
    zones: loaded.zones,
    scannerZoneIds: loaded.zoneIds,
    timeZone: loaded.orgTimeZone,
  });
  if (d.planUnknown && !event)
    ctx.log.warn('scan.access.plan_unknown', {
      code: 'ACCESS_PLAN_UNKNOWN',
      orgId: actor.orgId,
      passId: found.pass.id,
      templateId: found.pass.templateId,
    });
  if (!event)
    found.access = {
      decision: d,
      chain: chainOf(d.access.zone?.id ?? null, loaded.zones),
      gateBefore: loaded.gate,
      visitAt: loaded.visitAt,
      zoneId: d.access.zone?.id ?? null,
      sessionId: scopeSessionId(actor),
      limit: d.visitLimit,
      gapMs: (manifest.rules?.visitGapMinutes ?? DEFAULT_GAP_MINUTES) * MINUTE,
      waitMs:
        manifest.rules?.reentryMinutes == null ? null : manifest.rules.reentryMinutes * MINUTE,
    } satisfies FoundAccess;
  if (
    d.reason !== null &&
    !(waived === d.reason && ACCESS_WAIVABLE.has(d.reason)) &&
    (!event || ON_HOLD.has(d.reason))
  )
    return stop('refused', d.reason, { ...known, at: d.at, access: scanAccessOf(d) });
  return null;
}

/** What an override waives: a `cooldown` the wait, a `guest_visits_used` the limit. Nothing else waives either. */
export interface AccessWaive {
  wait: boolean;
  limit: boolean;
}
export const waiveOf = (reason: string | null | undefined): AccessWaive => ({
  wait: reason === 'cooldown',
  limit: reason === 'guest_visits_used',
});

/** Whether a grant at `now` starts a visit: the visit began a gap or more ago, or there is none. */
export const startsVisit = (access: FoundAccess, now: number) =>
  access.visitAt === null || access.gapMs === 0 || now - access.visitAt > access.gapMs;

/**
 * The gate's answer before the commit, from the row the preflight read: inside the wait is a
 * heads-up `cooldown`; a new visit past the limit is a red `guest_visits_used`. An override skips only
 * the reason it names. A scan that loses the gate to a racing one at commit is told to scan again
 * instead (the commit decides).
 */
export function accessGateStop(found: Found, now: number, waive: AccessWaive): Stop | null {
  const access = found.access;
  const before = access?.gateBefore;
  if (!access || !before) return null;
  const known = {
    pass: found.pass,
    ref: found.ref,
    found,
    connectionGeneration: found.connectionGeneration,
  };
  const since = now - before.lastAt;
  if (!waive.wait && access.waitMs !== null && since < access.waitMs)
    return stop('heads_up', 'cooldown', {
      ...known,
      at: before.lastAt,
      cooldownRemainingMs: access.waitMs - since,
      access: scanAccessOf(access.decision),
    });
  if (
    !waive.limit &&
    access.limit !== null &&
    startsVisit(access, now) &&
    before.count >= access.limit
  )
    return stop('refused', 'guest_visits_used', {
      ...known,
      access: scanAccessOf(access.decision, {
        visits: { used: before.count, limit: access.limit },
        visit: false,
      }),
    });
  return null;
}

/**
 * The `access` root of a result screen (DM 3.1): the plan, the deciding zone, when it closes or
 * opens, the pass's end, the plan's hours text and the visits. Null on any other template.
 */
export function accessScopeOf(
  found: Found,
  actor: ScanActor,
  view: ScanAccess | null,
): Json | null {
  const shown = view ?? (found.access ? scanAccessOf(found.access.decision) : null);
  const manifest = shown ? accessManifestOf(found) : null;
  if (!manifest || !shown) return null;
  const inputs = applyDefaults(found.activePolicy.manifest, found.pass.personalization);
  const base = accessScope(manifest, inputs, {
    createdAt: found.pass.createdAt,
    timeZone: shown.timeZone || actor.timeZone,
  });
  const visits = shown.visits;
  return {
    plan: shown.plan.label,
    kind: shown.plan.kind,
    zone: shown.zone?.name ?? null,
    closesAt: shown.closesAt,
    nextOpenAt: shown.nextOpenAt,
    until: base?.until ?? null,
    hours: base?.hours ?? '',
    visits: visits
      ? {
          used: visits.used,
          limit: visits.limit,
          left: visits.limit === null ? null : Math.max(0, visits.limit - visits.used),
        }
      : null,
  };
}
