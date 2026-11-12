import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import { ScannerSettingsSchema } from '../../../shared/contracts/scan.ts';
import type {
  CreateScanningSessionSchema,
  UpdateScanningSessionSchema,
} from '../../../shared/contracts/scanning-sessions.ts';
import { rowIs } from '../../platform/authority-checks.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { orgIsActive } from '../orgs/repo.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { tenantScanRole } from './actor.ts';
import { credentialKeysetContext } from './credential-keyset-authority.ts';
import { DEFAULT_SETTINGS, parseSettings } from './dto-console.ts';
import { kickScreen } from './live.ts';
import {
  adminGrant,
  audited,
  eventsOpen,
  scopeTemplatesUsable,
  sessionEpoch,
  templatesUsable,
} from './repo-admin-grant.ts';
import { addSessionPropagation, sessionDevicesAre } from './repo-scanner-configuration-sync.ts';
import { getConsoleScanner } from './repo-scanners.ts';
import { scanningDeviceRows } from './repo-scanning-devices.ts';
import {
  addScanningSessionInsert,
  addScanningSessionUpdate,
  type ScanningSessionRow,
  scanningSessionRow,
} from './repo-scanning-sessions.ts';
import { readScannerScope } from './repo-scope.ts';
import { acceptedTemplateIds, checkAccepts } from './scanner-validation.ts';
import {
  assertSessionReadAuthority,
  assertSessionWriteCountAuthority,
} from './scanning-session-authority.ts';
import {
  conflictsWithAllScope,
  deviceDto,
  effectiveSessionSettings,
  resolveSessionScope,
  type SessionCountAuthority,
  sessionDto,
} from './scanning-session-dto.ts';
import { scanningSessionActivity } from './session-activity.ts';

export { startAdminSetup } from './scanning-session-admin-setup.ts';

const SESSION_CODES = {
  config: 'SCANNING_SESSION_CHANGED',
  lineage: 'SCANNING_SESSION_CHANGED',
  stale: 'SCANNING_SESSION_CHANGED',
} as const;

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
export async function scanningSessionDetail(
  ctx: ServiceContext,
  id: string,
  mode: Mode,
  authority: TenantPassWrite,
  countAuthority: SessionCountAuthority,
) {
  assertSessionReadAuthority(mode, authority, countAuthority);
  return scanningSessionDetailForAuthority(ctx, id, mode, countAuthority);
}

async function scanningSessionDetailForAuthority(
  context: ServiceContext,
  id: string,
  mode: Mode,
  countAuthority: SessionCountAuthority,
) {
  const ctx = credentialKeysetContext(context);
  const row = await loadScanningSession(ctx, id, mode, countAuthority.orgId);
  const [session, devices, scope] = await Promise.all([
    sessionDto(ctx, row, countAuthority),
    scanningDeviceRows(ctx.env.DB, row.org_id, id),
    resolveSessionScope(ctx, row),
  ]);
  const deviceViews = await Promise.all(
    devices.map(async (d) => {
      const settings = effectiveSessionSettings(row, d);
      const scanner = await getConsoleScanner(ctx.env.DB, d.scanner_id);
      const invalidScannerScope =
        !scanner ||
        scanner.mode !== row.mode ||
        !(await readScannerScope(ctx.env.DB, scanner, null)).valid;
      const conflict =
        !!scanner && !!settings && (await conflictsWithAllScope(ctx, scanner, scope, settings));
      return deviceDto(
        d,
        ctx.clock.now(),
        settings
          ? {
              ...settings,
              acceptAllTemplates:
                !invalidScannerScope && !conflict && session.settings.acceptAllTemplates === true,
            }
          : { ...parseSettings(d.settings), acceptAllTemplates: false, lookup: false },
      );
    }),
  );
  const role = countAuthority.tenant ? tenantScanRole(countAuthority.tenant) : null;
  if (!role) throw new NotFoundError('Scanning session not found.', 'SCANNING_SESSION_NOT_FOUND');
  // A scope that resolves to nothing has no provable activity; the session stays viewable to fix it.
  const activity = scope.valid ? await scanningSessionActivity(ctx, row, countAuthority, role) : [];
  if (activity === null)
    throw new NotFoundError('Scanning session not found.', 'SCANNING_SESSION_NOT_FOUND');
  return { ...session, devices: deviceViews, activity };
}
export async function createScanningSession(
  ctx: ServiceContext,
  userId: string,
  mode: Mode,
  input: z.infer<typeof CreateScanningSessionSchema>,
  authority: TenantPassWrite,
  countAuthority: SessionCountAuthority,
) {
  assertSessionWriteCountAuthority(userId, authority, countAuthority);
  if (countAuthority.orgId !== input.orgId || countAuthority.mode !== mode)
    throw new NotFoundError('Scanning session not found.', 'SCANNING_SESSION_NOT_FOUND');
  if (!(await orgIsActive(ctx.env.DB, input.orgId)))
    throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  const accepts = input.accepts ? await checkAccepts(ctx, input.orgId, mode, input.accepts) : null;
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
  const g = adminGrant(
    ctx,
    'org_mode.scan.session.create',
    userId,
    authority,
    input.orgId,
    [
      ...eventsOpen([accepts?.eventId, settings.checkIn?.eventId]),
      ...templatesUsable(accepts?.templateIds ?? []),
    ],
    SESSION_CODES,
    id,
  );
  addScanningSessionInsert(
    g,
    {
      id,
      name: input.name,
      status: 'active',
      accepts: input.accepts ? JSON.stringify(input.accepts) : null,
      settings: JSON.stringify(settings),
      time_zone: input.timeZone,
      created_at: now,
      updated_at: now,
    },
    userId,
  );
  g.add(
    audited(g, ctx, {
      orgId: input.orgId,
      actorType: 'user',
      actorId: userId,
      action: 'scanning.session_create',
      targetType: 'scanning_session',
      targetId: id,
      detail: { mode },
    }),
  );
  await g.commit();
  return scanningSessionDetailForAuthority(ctx, id, mode, countAuthority);
}
export async function updateScanningSession(
  ctx: ServiceContext,
  userId: string,
  id: string,
  input: z.infer<typeof UpdateScanningSessionSchema>,
  authority: TenantPassWrite,
  countAuthority: SessionCountAuthority,
) {
  assertSessionWriteCountAuthority(userId, authority, countAuthority);
  const row = await loadScanningSession(ctx, id, authority.mode, authority.orgId);
  if (countAuthority.orgId !== row.org_id || countAuthority.mode !== row.mode)
    throw new NotFoundError('Scanning session not found.', 'SCANNING_SESSION_NOT_FOUND');
  if (input.revision !== undefined && input.revision !== row.updated_at)
    throw new ConflictError(
      'This session changed. Reload its settings and try again.',
      'SCANNING_SESSION_CHANGED',
    );
  const attached = acceptedTemplateIds(row.accepts);
  const accepted =
    input.accepts === undefined
      ? undefined
      : input.accepts === null
        ? null
        : await checkAccepts(ctx, row.org_id, row.mode, input.accepts, attached);
  const settingsChanged = input.settings !== undefined || input.accepts !== undefined;
  const previousSettings = settingsChanged ? effectiveSessionSettings(row) : null;
  if (settingsChanged && !previousSettings)
    throw new ValidationError(
      'Correct this scanning session’s settings in Scanning.',
      [],
      'SCANNING_SESSION_SETTINGS_INVALID',
    );
  const settings = settingsChanged
    ? ScannerSettingsSchema.parse({
        ...previousSettings,
        ...input.settings,
        acceptAllTemplates:
          input.accepts === undefined
            ? (previousSettings?.acceptAllTemplates ?? false)
            : input.accepts === null,
      })
    : null;
  if (input.settings?.checkIn?.eventId)
    await checkAccepts(ctx, row.org_id, row.mode, { eventId: input.settings.checkIn.eventId });
  const next: ScanningSessionRow = {
    ...row,
    name: input.name ?? row.name,
    status: input.status ?? row.status,
    time_zone: input.timeZone ?? row.time_zone,
    accepts:
      input.accepts === undefined
        ? row.accepts
        : input.accepts === null
          ? null
          : JSON.stringify(input.accepts),
    settings: settings ? JSON.stringify(settings) : row.settings,
  };
  const now = ctx.clock.now();
  const devices = await scanningDeviceRows(ctx.env.DB, row.org_id, id);
  const g = adminGrant(
    ctx,
    'org_mode.scan.session.update',
    userId,
    authority,
    row.org_id,
    [
      sessionEpoch(id, row.config_epoch),
      ...(input.revision === undefined
        ? []
        : [rowIs('scanning_sessions', id, { updated_at: input.revision }, 'stale')]),
      sessionDevicesAre(id, devices),
      ...eventsOpen([accepted?.eventId, input.settings?.checkIn?.eventId]),
      ...scopeTemplatesUsable(accepted?.templateIds ?? [], attached),
    ],
    SESSION_CODES,
    id,
  );
  addScanningSessionUpdate(
    g,
    id,
    {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.timeZone === undefined ? {} : { time_zone: input.timeZone }),
      ...(accepted === undefined ? {} : { accepts: next.accepts }),
      ...(settings ? { settings: next.settings } : {}),
    },
    now,
  );
  addSessionPropagation(
    g,
    next,
    devices,
    {
      settings: settingsChanged,
      timeZone: input.timeZone !== undefined,
      ...(accepted === undefined
        ? {}
        : { accepts: accepted ?? { eventId: null, templateIds: [] } }),
    },
    now,
  );
  g.add(
    audited(g, ctx, {
      orgId: row.org_id,
      actorType: 'user',
      actorId: userId,
      action: 'scanning.session_update',
      targetType: 'scanning_session',
      targetId: id,
      detail: { status: next.status },
    }),
  );
  try {
    await g.commit();
  } catch (error) {
    if (classifyD1Error(error)?.kind === 'unique')
      throw new ConflictError(
        'This session changed. Reload its settings and try again.',
        'SCANNING_SESSION_CHANGED',
      );
    throw error;
  }
  await Promise.all(devices.map((d) => kickScreen(ctx, row.org_id, row.mode, d.scanner_id)));
  return scanningSessionDetailForAuthority(ctx, id, row.mode, countAuthority);
}
