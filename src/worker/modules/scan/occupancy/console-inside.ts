// Console Who's in and Mark as out for a zone or an event (SA §20.9): org admins read names from the pass title.

import type { Mode } from '../../../../shared/contracts/common.ts';
import type { ScanWhosInList } from '../../../../shared/contracts/scan-whos-in.ts';
import { grant } from '../../../platform/authority.ts';
import { ConflictError, ForbiddenError, ValidationError } from '../../../platform/errors.ts';
import type { ServiceContext } from '../../../platform/service-context.ts';
import { grantedAudit } from '../../audit/repo-granted.ts';
import { capabilityChecks } from '../../passes/repo-authority.ts';
import { getPass } from '../../passes/repo-read-pass.ts';
import { ledgerRow } from '../ledger.ts';
import { type AdminAuthority, adminPrincipal } from '../repo-admin-grant.ts';
import { assertUnderOverrideCap, countOverride } from '../repo-override-cap.ts';
import { includeSystemRetentionProof } from '../repo-scan-retention-part.ts';
import { orgZoneRows } from '../repo-zones.ts';
import { ROLL_TABLES, type WithGrant } from '../roll-call/tables.ts';
import { scanPassChecks } from '../scan-pass-checks.ts';
import { SCAN_COMMIT_TABLES, scanIs } from '../scan-write-grant.ts';
import { ledgerEvent } from '../scan-write-statements.ts';
import type { Identify } from './inside-list.ts';
import { whosInList } from './inside-list.ts';
import { type InsideScope, zoneScope } from './inside-scope.ts';
import { signMarkOut } from './mark-out-retention.ts';
import { eventPlaceRead, passTitlesRead, presenceRead } from './repo-inside.ts';
import { type MarkOutScan, markOutEffect, markOutScan } from './repo-mark-out.ts';
import { runReads } from './repo-reads.ts';
import { exitAsGiven, liveIn } from './rules.ts';
import { addExit } from './service.ts';

export type ConsoleTarget = { kind: 'zone' | 'event'; id: string };

async function consoleScope(
  ctx: ServiceContext,
  orgId: string,
  mode: Mode,
  t: ConsoleTarget,
): Promise<InsideScope> {
  if (t.kind === 'zone') return zoneScope(await orgZoneRows(ctx.env.DB, orgId), [t.id]);
  const [res] = await runReads(ctx.env.DB, [eventPlaceRead(orgId, mode, t.id)]);
  const e = (res?.results ?? [])[0] as
    | { name: string; capacity: number | null; reentry: number }
    | undefined;
  return {
    nested: {},
    places:
      e?.reentry === 1
        ? [
            {
              place: `event:${t.id}`,
              name: e.name,
              parentName: null,
              capacity: e.capacity,
              maxStayMs: null,
            },
          ]
        : [],
  };
}

export const titles =
  (ctx: ServiceContext, orgId: string, mode: Mode): Identify =>
  async (ids) => {
    const out = new Map<
      string,
      {
        holder: string | null;
        photoUrl: null;
        plan: null;
        type: string | null;
        host: null;
        ended: boolean;
      }
    >();
    if (ids.length === 0) return out;
    const [res] = await runReads(ctx.env.DB, [passTitlesRead(orgId, mode, ids)]);
    for (const r of (res?.results ?? []) as {
      id: string;
      title: string | null;
      type: string | null;
      status: string;
      removedAt: number | null;
      deletedAt: number | null;
    }[])
      out.set(r.id, {
        holder: r.title,
        photoUrl: null,
        plan: null,
        type: r.type,
        host: null,
        ended: r.status !== 'active' || r.removedAt !== null || r.deletedAt !== null,
      });
    return out;
  };

export async function consoleInside(
  ctx: ServiceContext,
  orgId: string,
  mode: Mode,
  t: ConsoleTarget,
  q: {
    place?: string | undefined;
    q?: string | undefined;
    cursor?: string | undefined;
    limit: number;
  },
): Promise<ScanWhosInList> {
  return whosInList({
    db: ctx.env.DB,
    orgId,
    mode,
    scope: await consoleScope(ctx, orgId, mode, t),
    ...q,
    now: ctx.clock.now(),
    identify: titles(ctx, orgId, mode),
  });
}

/** Mark one pass out of a place in the zone or event. Audited; the scan row is the console user's. */
export async function consoleMarkOut(
  ctx: ServiceContext,
  userId: string,
  authority: AdminAuthority,
  t: ConsoleTarget,
  input: { passId: string; place: string },
  extra?: WithGrant,
): Promise<string> {
  const { orgId, mode } = authority;
  const scope = await consoleScope(ctx, orgId, mode, t);
  const pass = scope.places.some((p) => p.place === input.place)
    ? await getPass(ctx.env.DB, input.passId, orgId)
    : null;
  if (!pass || pass.mode !== mode)
    throw new ValidationError('That person cannot be marked out.', [], 'SCAN_MARK_OUT_INVALID');
  const now = ctx.clock.now();
  const [row] = await runReads(ctx.env.DB, [presenceRead(orgId, pass.id, input.place)]);
  const held = (row?.results ?? [])[0] as
    | { state: 'in' | 'out'; dueAt: number | null; lastScanId: string }
    | undefined;
  if (!held || !liveIn({ state: held.state, due_at: held.dueAt }, now))
    throw new ConflictError('They are already out.', 'NOT_INSIDE');
  const capActor = { orgId, actorKey: `u:${userId}`, actor: { type: 'user' as const, id: userId } };
  // A roll call Out is not a desk override: an evacuation must not meet the hourly cap.
  if (!extra) await assertUnderOverrideCap(ctx, capActor);
  const scanId = ctx.ids.ordered(now);
  // Desk work, so `passes:operate` suffices: the same right the device API gives an admin.
  if (authority.userId !== userId || authority.orgId !== orgId) throw new ForbiddenError();
  const scanRow: MarkOutScan = {
    id: scanId,
    now,
    passId: pass.id,
    templateId: pass.templateId,
    passVersion: pass.version,
    place: input.place,
    actorType: 'user',
    actorId: userId,
    actorKey: `u:${userId}`,
    scannerId: null,
    staffId: null,
    sessionId: null,
    apiKeyId: null,
    eventId: t.kind === 'event' ? t.id : null,
    idempotencyKey: ctx.ids.id(),
    requestHash: 'console',
  };
  const ledger = ledgerRow(
    ctx,
    {
      actor: { type: 'user', id: userId },
      event: scanRow.eventId ? { id: scanRow.eventId } : null,
      scanner: null,
      staff: null,
    } as never,
    {
      pass,
      scanId,
      action: null,
      outcome: 'ok',
      reason: null,
      method: 'manual',
      override: false,
      approvedBy: null,
      direction: 'out',
      place: input.place,
      exit: 'desk',
    },
  );
  const { event, retention } = await signMarkOut(
    ctx.env,
    ledger,
    scanRow,
    { kind: 'console', purpose: 'org_mode.scan.mark_out' },
    await markOutEffect(ctx.env.DB, scanRow, orgId),
  );
  const g = grant(ctx, {
    purpose: 'org_mode.scan.mark_out',
    principal: adminPrincipal(authority),
    checks: [...capabilityChecks(authority), ...scanPassChecks(pass.id, { pass, credential: {} })],
    tables: extra ? [...SCAN_COMMIT_TABLES, ...ROLL_TABLES] : [...SCAN_COMMIT_TABLES],
    codes: { lineage: 'SCAN_PASS_CHANGED' },
    target: pass.id,
  });
  const zones = await orgZoneRows(ctx.env.DB, orgId);
  const { won } = addExit(g, {
    passId: pass.id,
    scanId,
    now,
    plan: exitAsGiven(zones, input.place),
    lastScanId: held.lastScanId,
  });
  const inserted = markOutScan(g, scanRow, [won]);
  ledgerEvent(g, event, scanId, 'ok', null);
  includeSystemRetentionProof(g, retention, [scanIs(scanId, { state: 'done' })]);
  grantedAudit(
    g,
    ctx,
    {
      orgId,
      actorType: 'user',
      actorId: userId,
      action: 'scan.mark_out',
      targetType: 'pass',
      targetId: pass.id,
      detail: { place: input.place, scanId, via: 'console' },
    },
    [scanIs(scanId, { state: 'done' })],
  );
  extra?.(g, scanId, won);
  const committed = await g.commit();
  if (!(committed[g.indexOf(inserted)]?.results ?? []).length)
    throw new ConflictError('They are already out.', 'NOT_INSIDE');
  if (!extra) await countOverride(ctx, capActor);
  return scanId;
}
