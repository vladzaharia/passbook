// POST /scan/mark-out (SA §20.9): a Desk-role person closes a forgotten in row. Allowed while the session is paused.

import type { z } from 'zod';
import type { ScanOutcome } from '../../../../shared/contracts/scan.ts';
import type { ScanMarkOutRequestSchema } from '../../../../shared/contracts/scan-occupancy.ts';
import { ConflictError, ForbiddenError, ValidationError } from '../../../platform/errors.ts';
import { sha256Hex } from '../../../platform/ids.ts';
import type { ServiceContext } from '../../../platform/service-context.ts';
import { grantedAudit } from '../../audit/repo-granted.ts';
import { getPass } from '../../passes/repo-read-pass.ts';
import { policyActor } from '../dto.ts';
import type { ScanActor } from '../guard.ts';
import { ledgerRow } from '../ledger.ts';
import { blankOutcome } from '../outcome.ts';
import { assertUnderOverrideCap, countOverride } from '../repo-override-cap.ts';
import { includeSystemRetentionProof } from '../repo-scan-retention-part.ts';
import { scanByKey } from '../repo-scans.ts';
import { ROLL_TABLES, type WithGrant } from '../roll-call/tables.ts';
import { scanPolicy } from '../rules.ts';
import { SCAN_COMMIT_TABLES, scanIs, scanWriteGrant } from '../scan-write-grant.ts';
import { ledgerEvent } from '../scan-write-statements.ts';
import { scannerRefusal } from '../scanner-credential-lost.ts';
import { sessionInsideScope, zoneScope } from './inside-scope.ts';
import { signMarkOut } from './mark-out-retention.ts';
import { presenceRead } from './repo-inside.ts';
import { type MarkOutScan, markOutEffect, markOutScan } from './repo-mark-out.ts';
import { countsRead, runReads } from './repo-reads.ts';
import { exitAsGiven, liveIn } from './rules.ts';
import { addExit, occupancyZones } from './service.ts';

type MarkOutRequest = z.infer<typeof ScanMarkOutRequestSchema>;

const invalid = () =>
  new ValidationError('That person cannot be marked out.', [], 'SCAN_MARK_OUT_INVALID');

export function markOutOutcome(
  now: number,
  scanId: string,
  place: { place: string; name: string; capacity: number | null },
  o: { stayMs: number | null; inNow: number; via: string; replay: boolean },
): ScanOutcome {
  const [kind, id] = place.place.split(':') as ['zone' | 'event', string];
  return {
    ...blankOutcome('ok', {
      approvals: false,
      counts: {
        today: 0,
        event: null,
        place: { name: place.name, inNow: o.inNow, capacity: place.capacity },
        asOf: now,
        configRev: 0,
      },
    }),
    scanId,
    replay: o.replay,
    at: now,
    occupancy: {
      place: { kind, id, name: place.name },
      direction: 'out',
      auto: false,
      state: 'out',
      since: now,
      via: o.via,
      stayMs: o.stayMs,
      inNow: o.inNow,
      capacity: place.capacity,
      turnaround: null,
    },
  };
}

export async function markOut(
  ctx: ServiceContext,
  actor: ScanActor,
  req: MarkOutRequest,
  extra?: WithGrant,
): Promise<ScanOutcome> {
  if (!scanPolicy(policyActor(actor), { kind: 'mark_out' }).allow)
    throw new ForbiddenError('Only Desk and above can mark someone out.', 'FORBIDDEN');
  const db = ctx.env.DB;
  const zones = await occupancyZones(db, actor.orgId);
  // The session's places; an admin with no session reaches every tracked zone of the org.
  const scope =
    actor.principal === 'admin' && !actor.scanningSession
      ? zoneScope(
          zones,
          zones.filter((z) => z.parentId === null).map((z) => z.id),
          // Membership, not a list: no page limit.
          Number.POSITIVE_INFINITY,
        )
      : await sessionInsideScope(db, actor, { place: req.place, max: Number.POSITIVE_INFINITY });
  const place = scope.places.find((p) => p.place === req.place);
  const pass = place ? await getPass(db, req.passId, actor.orgId) : null;
  if (!place || !pass || pass.mode !== actor.mode) throw invalid();

  const requestHash = await sha256Hex(JSON.stringify([req.passId, req.place]));
  const prior = await scanByKey(db, actor.actorKey, req.idempotencyKey);
  const now = ctx.clock.now();
  const done = (replay: boolean, inNow: number, stayMs: number | null, id: string, at: number) =>
    markOutOutcome(at, id, place, { stayMs, inNow, via: actor.name, replay });
  const countNow = async () => {
    const [counts] = await runReads(db, [countsRead(actor.orgId, actor.mode, [req.place], now)]);
    return ((counts?.results ?? [])[0] as { n?: number } | undefined)?.n ?? 0;
  };
  if (prior)
    if (prior.state === 'done' && prior.outcome === 'ok' && prior.requestHash === requestHash)
      return done(true, await countNow(), null, prior.id, prior.at);
    else
      throw new ConflictError('That request key was used for something else.', 'SCAN_KEY_REUSED');

  const [row] = await runReads(db, [presenceRead(actor.orgId, req.passId, req.place)]);
  const held = (row?.results ?? [])[0] as
    | { state: 'in' | 'out'; enteredAt: number | null; dueAt: number | null; lastScanId: string }
    | undefined;
  if (!held || !liveIn({ state: held.state, due_at: held.dueAt }, now))
    throw new ConflictError('They are already out.', 'NOT_INSIDE');

  // A roll call Out is not a desk override: an evacuation must not meet the hourly cap.
  if (!extra) await assertUnderOverrideCap(ctx, actor);
  const scanId = ctx.ids.ordered(now);
  const scanRow: MarkOutScan = {
    id: scanId,
    now,
    passId: pass.id,
    templateId: pass.templateId,
    passVersion: pass.version,
    place: req.place,
    actorType: actor.actor.type,
    actorId: actor.actor.id,
    actorKey: actor.actorKey,
    scannerId: actor.scanner?.id ?? null,
    staffId: actor.staff?.id ?? null,
    sessionId: actor.scanningSession?.id ?? null,
    apiKeyId: actor.apiKeyId ?? null,
    eventId: req.place.startsWith('event:') ? req.place.slice(6) : (actor.event?.id ?? null),
    idempotencyKey: req.idempotencyKey,
    requestHash,
  };
  const ledger = ledgerRow(ctx, actor, {
    pass,
    scanId,
    action: null,
    outcome: 'ok',
    reason: null,
    method: 'manual',
    override: false,
    approvedBy: null,
    direction: 'out',
    place: req.place,
    exit: 'desk',
  });
  const { event, retention } = await signMarkOut(
    ctx.env,
    ledger,
    scanRow,
    { kind: 'device', purpose: 'org_mode.scan.check_in' },
    await markOutEffect(db, scanRow, actor.orgId),
  );
  const g = scanWriteGrant(ctx, actor, {
    purpose: 'org_mode.scan.check_in',
    now,
    pausedSession: true,
    pass: { id: pass.id, facts: { pass, credential: {} } },
    tables: extra ? [...SCAN_COMMIT_TABLES, ...ROLL_TABLES] : SCAN_COMMIT_TABLES,
  });
  const { won } = addExit(g, {
    passId: pass.id,
    scanId,
    now,
    plan: exitAsGiven(zones, req.place),
    // The row the desk read: a tap-out and tap-in since is a new stay and is left alone.
    lastScanId: held.lastScanId,
  });
  const inserted = markOutScan(g, scanRow, [won]);
  ledgerEvent(g, event, scanId, 'ok', null);
  includeSystemRetentionProof(g, retention, [scanIs(scanId, { state: 'done' })]);
  grantedAudit(
    g,
    ctx,
    {
      orgId: actor.orgId,
      actorType: actor.actor.type,
      actorId: actor.actor.id,
      action: 'scan.mark_out',
      targetType: 'pass',
      targetId: pass.id,
      detail: {
        place: req.place,
        scanId,
        via:
          actor.principal === 'admin'
            ? 'console'
            : actor.scanner?.deviceRole === 'monitor'
              ? 'monitor'
              : 'scanner',
        ...(actor.staff ? { staffId: actor.staff.id } : {}),
      },
    },
    [scanIs(scanId, { state: 'done' })],
  );
  extra?.(g, scanId, won);
  try {
    const committed = await g.commit();
    if (!(committed[g.indexOf(inserted)]?.results ?? []).length) {
      // The same key racing itself: the winner's answer is this one's.
      const twin = await scanByKey(db, actor.actorKey, req.idempotencyKey);
      if (twin?.state === 'done' && twin.outcome === 'ok' && twin.requestHash === requestHash)
        return done(true, await countNow(), null, twin.id, twin.at);
      throw new ConflictError('They are already out.', 'NOT_INSIDE');
    }
  } catch (error) {
    if (error instanceof ConflictError) throw error;
    throw await scannerRefusal(ctx, actor, error);
  }
  if (!extra) await countOverride(ctx, actor);
  return done(
    false,
    await countNow(),
    held.enteredAt === null ? null : now - held.enteredAt,
    scanId,
    now,
  );
}
