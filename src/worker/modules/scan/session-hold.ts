import type { z } from 'zod';
import type {
  ScanSessionOpenNowSchema,
  SessionHold,
  SessionHoldRequestSchema,
} from '../../../shared/contracts/scanning-sessions.ts';
import { rowIs } from '../../platform/authority-checks.ts';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  ValidationError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { verifyApproval } from './approval.ts';
import type { ScanActor } from './guard.ts';
import { kickScreen } from './live.ts';
import { adminGrant, audited, sessionEpoch } from './repo-admin-grant.ts';
import { scanningDeviceRows } from './repo-scanning-devices.ts';
import { addScanningSessionUpdate, type ScanningSessionRow } from './repo-scanning-sessions.ts';
import { liveActorGuard } from './repo-tags-bind.ts';
import { guardMiss } from './repo-undo-approval-guard.ts';
import { scanWriteGrant } from './scan-write-grant.ts';
import { scannerRefusal } from './scanner-credential-lost.ts';
import { assertSessionWriteCountAuthority } from './scanning-session-authority.ts';
import type { SessionReadAuthority } from './scanning-session-dto.ts';
import { loadScanningSession, scanningSessionDetailForAuthority } from './scanning-sessions.ts';
import {
  defaultOpenUntil,
  HOLD_MAX_MS,
  nextEdgeAt,
  nextScheduledOpen,
  sessionWindow,
} from './session-hours.ts';

type HoldRequest = z.infer<typeof SessionHoldRequestSchema>;
type OpenNow = z.infer<typeof ScanSessionOpenNowSchema>;
type HoldAction = 'close' | 'open' | 'clear';

const AUDIT_ACTION = {
  close: 'scanning.session_closed',
  open: 'scanning.session_opened',
  clear: 'scanning.session_hold_cleared',
} as const;
const CODES = {
  config: 'SCANNING_SESSION_CHANGED',
  lineage: 'SCANNING_SESSION_CHANGED',
  stale: 'SCANNING_SESSION_CHANGED',
} as const;

/** The hold an action asks for, or the refusal. Status stays the master switch: only an active session holds. */
export function planHold(
  row: ScanningSessionRow,
  req: { action: HoldAction; until?: number | undefined },
  now: number,
): SessionHold | null {
  if (req.action === 'clear') return null;
  if (row.status !== 'active')
    throw new ConflictError('Resume the scanning session first.', 'SCANNING_SESSION_PAUSED');
  const open = sessionWindow(row, now).open;
  if (req.action === 'close') {
    if (!open) throw new ConflictError('Scanning is already closed.', 'SCANNING_SESSION_CLOSED');
    const until = nextScheduledOpen(row, now);
    if (until === null)
      throw new ValidationError(
        'Nothing opens in the next 8 days. Use Pause.',
        [],
        'SCANNING_HOURS_NONE',
      );
    return { state: 'closed', until };
  }
  if (open) throw new ConflictError('Scanning is already open.', 'SCANNING_SESSION_OPEN');
  const until = req.until ?? defaultOpenUntil(row, now);
  if (until <= now || until > now + HOLD_MAX_MS)
    throw new BadRequestError('Open for up to 24 hours.', 'SCANNING_HOLD_RANGE');
  return { state: 'open', until };
}

/** The columns a hold change writes. */
const holdPatch = (row: ScanningSessionRow, hold: SessionHold | null, now: number) => {
  const next = { ...row, hold: hold ? JSON.stringify(hold) : null };
  return { hold: next.hold, hours_next_at: row.status === 'active' ? nextEdgeAt(next, now) : null };
};

const kickDevices = async (ctx: ServiceContext, row: ScanningSessionRow) =>
  Promise.all(
    (await scanningDeviceRows(ctx.env.DB, row.org_id, row.id)).map((d) =>
      kickScreen(ctx, row.org_id, row.mode, d.scanner_id),
    ),
  );

/** Close now, Open now or Back to hours from the console (same authority as an update). */
export async function holdScanningSession(
  ctx: ServiceContext,
  userId: string,
  id: string,
  input: HoldRequest,
  authority: TenantPassWrite,
  countAuthority: SessionReadAuthority,
) {
  assertSessionWriteCountAuthority(userId, authority, countAuthority);
  const row = await loadScanningSession(ctx, id, authority.mode, authority.orgId);
  if (input.revision !== undefined && input.revision !== row.updated_at)
    throw new ConflictError(
      'This session changed. Reload its settings and try again.',
      'SCANNING_SESSION_CHANGED',
    );
  const now = ctx.clock.now();
  const hold = planHold(row, input, now);
  const g = adminGrant(
    ctx,
    'org_mode.scan.session.hold',
    userId,
    authority,
    row.org_id,
    [
      sessionEpoch(id, row.config_epoch),
      ...(input.revision === undefined
        ? []
        : [rowIs('scanning_sessions', id, { updated_at: input.revision }, 'stale')]),
    ],
    CODES,
    id,
  );
  addScanningSessionUpdate(g, id, holdPatch(row, hold, now), now);
  g.add(
    audited(g, ctx, {
      orgId: row.org_id,
      actorType: 'user',
      actorId: userId,
      action: AUDIT_ACTION[input.action],
      targetType: 'scanning_session',
      targetId: id,
      detail: { by: 'user', ...(hold ? { until: hold.until } : {}) },
    }),
  );
  await g.commit();
  await kickDevices(ctx, row);
  return scanningSessionDetailForAuthority(ctx, id, row.mode, countAuthority);
}

/** A Manager opens early at the door: signed in as one, or with a manager code. Audited. */
export async function openNowOnScanner(ctx: ServiceContext, actor: ScanActor, req: OpenNow) {
  try {
    return await openNow(ctx, actor, req);
  } catch (error) {
    throw await scannerRefusal(ctx, actor, error);
  }
}

async function openNow(ctx: ServiceContext, actor: ScanActor, req: OpenNow) {
  if (actor.terminal || actor.apiKeyId || !actor.scanner || !actor.scanningSession)
    throw new ForbiddenError('A manager must open this.', 'SESSION_OPEN_FORBIDDEN');
  const now = ctx.clock.now();
  let approver: { id: string; authEpoch: number } | null = null;
  if (actor.role !== 'manager') {
    if (!req.approval)
      throw new ForbiddenError('A manager must open this.', 'SESSION_OPEN_FORBIDDEN');
    if (!req.approval.staffId && actor.settings.staffSignIn)
      throw new ValidationError('Choose the manager.', [], 'PIN_MANAGER_REQUIRED');
    const verified = await verifyApproval(ctx, actor, req.approval, liveActorGuard(actor, now));
    if (!verified) throw (await guardMiss(ctx.env.DB, actor, now)) ?? new ForbiddenError();
    approver = { id: verified.id, authEpoch: verified.authEpoch };
  }
  const row = await loadScanningSession(ctx, actor.scanningSession.id, actor.mode, actor.orgId);
  const hold = planHold(row, { action: 'open', until: req.until }, now);
  const g = scanWriteGrant(ctx, actor, {
    purpose: 'org_mode.scan.hold',
    now,
    approver,
    codes: CODES,
  });
  addScanningSessionUpdate(g, row.id, holdPatch(row, hold, now), now);
  g.add(
    grantedAudit(g, ctx, {
      orgId: row.org_id,
      actorType: actor.actor.type,
      actorId: actor.actor.id,
      action: AUDIT_ACTION.open,
      targetType: 'scanning_session',
      targetId: row.id,
      detail: {
        by: 'user',
        via: 'scanner',
        scannerId: actor.scanner.id,
        ...(approver
          ? { approvedBy: approver.id }
          : actor.staff
            ? { staffId: actor.staff.id }
            : {}),
        until: hold?.until ?? null,
      },
    }),
  );
  await g.commit();
  await kickDevices(ctx, row);
  return { window: sessionWindow({ ...row, hold: JSON.stringify(hold) }, now) };
}
