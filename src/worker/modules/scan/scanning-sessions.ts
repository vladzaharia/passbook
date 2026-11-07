import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import { ScannerSettingsSchema } from '../../../shared/contracts/scan.ts';
import type {
  CreateScanningSessionSchema,
  ScanningSessionQuerySchema,
  UpdateScanningSessionSchema,
} from '../../../shared/contracts/scanning-sessions.ts';
import { batch, classifyD1Error } from '../../platform/db.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';
import { orgIsActive } from '../orgs/repo.ts';
import { DEFAULT_SETTINGS, parseSettings } from './dto-console.ts';
import { kickScreen } from './live.ts';
import { scanningDeviceRows } from './repo-scanning-devices.ts';
import {
  claimConfigRevisionStmt,
  insertScanningSessionStmt,
  listScanningSessionRows,
  type ScanningSessionRow,
  scanningSessionRow,
  updateScanningSessionStmt,
} from './repo-scanning-sessions.ts';
import { scanningSessionActivity } from './repo-session-activity.ts';
import { propagateSessionStmts } from './repo-session-propagation.ts';
import { checkAccepts } from './scanners.ts';
import { deviceDto, sessionDto } from './scanning-session-dto.ts';

export async function loadScanningSession(
  ctx: ServiceContext,
  id: string,
  mode?: Mode,
  orgId: string | null = null,
) {
  const row = await scanningSessionRow(ctx.env.DB, orgId, id);
  if (!row || (mode !== undefined && row.mode !== mode))
    throw new NotFoundError('Scanning session not found.', 'SCANNING_SESSION_NOT_FOUND');
  return row;
}
export async function listScanningSessions(
  ctx: ServiceContext,
  mode: Mode,
  query: z.infer<typeof ScanningSessionQuerySchema>,
) {
  const rows = await listScanningSessionRows(ctx.env.DB, mode, query);
  const page = rows.slice(0, query.limit);
  return {
    items: await Promise.all(page.map((row) => sessionDto(ctx, row))),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}
export async function scanningSessionDetail(ctx: ServiceContext, id: string, mode?: Mode) {
  const row = await loadScanningSession(ctx, id, mode);
  const [session, devices] = await Promise.all([
    sessionDto(ctx, row),
    scanningDeviceRows(ctx.env.DB, row.org_id, id),
  ]);
  return {
    ...session,
    devices: devices.map((d) => deviceDto(d, ctx.clock.now())),
    activity: await scanningSessionActivity(ctx.env.DB, row.org_id, id, row.mode),
  };
}
export async function createScanningSession(
  ctx: ServiceContext,
  userId: string,
  mode: Mode,
  input: z.infer<typeof CreateScanningSessionSchema>,
) {
  if (!(await orgIsActive(ctx.env.DB, input.orgId)))
    throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  if (input.accepts) await checkAccepts(ctx, input.orgId, mode, input.accepts);
  const settings = ScannerSettingsSchema.parse({
    ...DEFAULT_SETTINGS,
    lookup: true,
    ...input.settings,
    acceptAllTemplates: input.accepts === null,
  });
  if (settings.checkIn?.eventId)
    await checkAccepts(ctx, input.orgId, mode, { eventId: settings.checkIn.eventId });
  const now = ctx.clock.now();
  const id = ctx.ids.id();
  await batch(ctx.env.DB, [
    insertScanningSessionStmt(
      ctx.env.DB,
      {
        id,
        org_id: input.orgId,
        mode,
        name: input.name,
        status: 'active',
        accepts: input.accepts ? JSON.stringify(input.accepts) : null,
        settings: JSON.stringify(settings),
        time_zone: input.timeZone,
        created_at: now,
        updated_at: now,
      },
      userId,
    ),
    auditStmt(ctx.env.DB, ctx, {
      orgId: input.orgId,
      actorType: 'user',
      actorId: userId,
      action: 'scanning.session_create',
      targetType: 'scanning_session',
      targetId: id,
      detail: { mode },
    }),
  ]);
  return scanningSessionDetail(ctx, id, mode);
}
export async function updateScanningSession(
  ctx: ServiceContext,
  userId: string,
  id: string,
  input: z.infer<typeof UpdateScanningSessionSchema>,
) {
  const row = await loadScanningSession(ctx, id);
  if (input.revision !== undefined && input.revision !== row.updated_at)
    throw new ConflictError(
      'This session changed. Reload its settings and try again.',
      'SCANNING_SESSION_CHANGED',
    );
  const accepts =
    input.accepts === undefined ? (row.accepts ? JSON.parse(row.accepts) : null) : input.accepts;
  const accepted = accepts ? await checkAccepts(ctx, row.org_id, row.mode, accepts) : null;
  const settings = ScannerSettingsSchema.parse({
    ...parseSettings(row.settings),
    ...input.settings,
    acceptAllTemplates:
      input.accepts === undefined
        ? (parseSettings(row.settings).acceptAllTemplates ?? false)
        : accepts === null,
  });
  if (settings.checkIn?.eventId)
    await checkAccepts(ctx, row.org_id, row.mode, { eventId: settings.checkIn.eventId });
  const next: ScanningSessionRow = {
    ...row,
    name: input.name ?? row.name,
    status: input.status ?? row.status,
    time_zone: input.timeZone ?? row.time_zone,
    accepts: accepts ? JSON.stringify(accepts) : null,
    settings: JSON.stringify(settings),
    updated_at: Math.max(ctx.clock.now(), row.updated_at + 1),
  };
  try {
    await batch(ctx.env.DB, [
      claimConfigRevisionStmt(ctx.env.DB, 'session', id, row.updated_at),
      updateScanningSessionStmt(ctx.env.DB, next),
      ...propagateSessionStmts(
        ctx.env.DB,
        next,
        accepted?.templateIds ?? [],
        accepted?.eventId ?? null,
      ),
      auditStmt(ctx.env.DB, ctx, {
        orgId: row.org_id,
        actorType: 'user',
        actorId: userId,
        action: 'scanning.session_update',
        targetType: 'scanning_session',
        targetId: id,
        detail: { status: next.status },
      }),
    ]);
  } catch (error) {
    if (classifyD1Error(error)?.kind === 'unique')
      throw new ConflictError(
        'This session changed. Reload its settings and try again.',
        'SCANNING_SESSION_CHANGED',
      );
    throw error;
  }
  const devices = await scanningDeviceRows(ctx.env.DB, row.org_id, id);
  await Promise.all(devices.map((d) => kickScreen(ctx, row.org_id, row.mode, d.scanner_id)));
  return scanningSessionDetail(ctx, id);
}
