// Who is calling a roll call: a scanner or a signed-in desk, or the console and an API key. Each brings its
// own scope (the places), names, and write grant; the service does not care which.
import type { Mode } from '../../../../shared/contracts/common.ts';
import type { ScanWhosInList } from '../../../../shared/contracts/scan-whos-in.ts';
import { type Grant, grant } from '../../../platform/authority.ts';
import { ConflictError } from '../../../platform/errors.ts';
import type { ServiceContext } from '../../../platform/service-context.ts';
import type { AuditActorType } from '../../audit/types.ts';
import type { TenantPassWrite } from '../../passes/http.ts';
import { capabilityChecks, tenantPrincipal } from '../../passes/repo-authority.ts';
import type { ScanActor } from '../guard.ts';
import { titles } from '../occupancy/console-inside.ts';
import { whosInList } from '../occupancy/inside-list.ts';
import { type InsideScope, sessionInsideScope, zoneScope } from '../occupancy/inside-scope.ts';
import { occupancyZones } from '../occupancy/service.ts';
import { whosIn } from '../occupancy/whos-in.ts';
import { sessionZoneIds } from '../repo-zones.ts';
import { scanWriteGrant } from '../scan-write-grant.ts';

export type ListQuery = { cursor?: string; limit: number };

export interface Caller {
  orgId: string;
  mode: Mode;
  /** `session:<id>` for a scanning session, `org` for every tracked zone. */
  scopeKey: string;
  by: string;
  byId: string | null;
  scannerId: string | null;
  actor: { type: AuditActorType; id: string | null };
  via: 'scanner' | 'console';
  scope(): Promise<InsideScope>;
  list(q: ListQuery): Promise<ScanWhosInList>;
  grant(now: number): Grant;
}

const TABLES = ['roll_calls', 'roll_call_marks'];

export function deviceCaller(ctx: ServiceContext, actor: ScanActor): Caller {
  const session = actor.scanningSession;
  if (!session)
    throw new ConflictError('This device is not in a scanning session.', 'ROLL_CALL_NO_SESSION');
  return {
    orgId: actor.orgId,
    mode: actor.mode,
    scopeKey: `session:${session.id}`,
    by: actor.staff?.name ?? actor.name,
    byId: actor.staff?.id ?? null,
    scannerId: actor.scanner?.id ?? null,
    actor: actor.actor,
    via: 'scanner',
    scope: () => sessionInsideScope(ctx.env.DB, actor, { max: Number.POSITIVE_INFINITY }),
    list: (q) => whosIn(ctx, actor, q),
    grant: (now) =>
      scanWriteGrant(ctx, actor, {
        purpose: 'org_mode.scan.roll_call',
        now,
        pausedSession: true,
        tables: TABLES,
      }),
  };
}

/** A console user or an API key: one session's places, or every tracked root zone of the org. */
export function tenantCaller(
  ctx: ServiceContext,
  authority: TenantPassWrite,
  who: { type: 'user' | 'api_key'; id: string | null; name: string },
  sessionId: string | null,
): Caller {
  const { orgId, mode } = authority;
  const db = ctx.env.DB;
  const scope = async () => {
    const zones = await occupancyZones(db, orgId);
    const roots = sessionId
      ? await sessionZoneIds(db, orgId, sessionId)
      : zones.filter((z) => z.parentId === null).map((z) => z.id);
    return zoneScope(zones, roots, Number.POSITIVE_INFINITY);
  };
  return {
    orgId,
    mode,
    scopeKey: sessionId ? `session:${sessionId}` : 'org',
    by: who.name,
    byId: who.id,
    scannerId: null,
    actor: { type: who.type, id: who.id },
    via: 'console',
    scope,
    list: async (q) =>
      whosInList({
        db,
        orgId,
        mode,
        scope: await scope(),
        ...q,
        now: ctx.clock.now(),
        identify: titles(ctx, orgId, mode),
      }),
    grant: () =>
      grant(ctx, {
        purpose: 'org_mode.scan.roll_call',
        principal: tenantPrincipal(authority),
        checks: capabilityChecks(authority),
        tables: TABLES,
      }),
  };
}
