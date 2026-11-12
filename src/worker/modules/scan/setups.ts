import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import { ScannerSettingsSchema } from '../../../shared/contracts/scan.ts';
import type {
  CreateScannerSetupSchema,
  UpdateScannerSetupSchema,
} from '../../../shared/contracts/scan-setups.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { orgIsActive } from '../orgs/repo.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { getUser } from '../users/repo.ts';
import { DEFAULT_SETTINGS } from './dto-console.ts';
import { assertStandaloneSession } from './legacy-session.ts';
import { kickScreen } from './live.ts';
import { createPairing } from './pairing.ts';
import { TERMINAL_TTL_MS } from './pairing-token.ts';
import {
  adminGrant,
  audited,
  eventsOpen,
  scannerEpoch,
  scopeTemplatesUsable,
  sessionEpoch,
} from './repo-admin-grant.ts';
import {
  addScannerTemplates,
  addSetupInsert,
  addSetupWatch,
  replaceScannerTemplates,
} from './repo-admin-unguarded.ts';
import { addScannerPatchSessionSync } from './repo-scanner-configuration-sync.ts';
import { addScannerInsert, addScannerPatch } from './repo-scanners.ts';
import { scanningDeviceRow } from './repo-scanning-devices.ts';
import { type ScanningSessionRow, scanningSessionForDevice } from './repo-scanning-sessions.ts';
import {
  addDeviceRole,
  addSetupAcceptsClear,
  setupMeta,
  watchedScanners,
  watchOf,
} from './repo-setups.ts';
import { acceptedTemplateIds, checkAccepts, requireScannerSettings } from './scanner-validation.ts';
import { loadScanner } from './scanner-views.ts';
import { addEnrollment, type DeviceEnrollment } from './scanning-enrollment.ts';
import { setupView } from './setup-views.ts';

const SETUP_CODES = { config: 'SCANNER_CHANGED', lineage: 'SCANNER_CHANGED' } as const;

type Create = z.infer<typeof CreateScannerSetupSchema>;
type Update = z.infer<typeof UpdateScannerSetupSchema>;
type Watch = Create['watch'];

function roleAllowed(kind: Create['kind'], role: Create['deviceRole']) {
  if ((kind === 'terminal' && role !== 'scan') || (kind === 'display' && role === 'scan'))
    throw new ValidationError('Choose a role this device supports.', [], 'SCANNER_ROLE_INVALID');
}

async function checkWatch(
  ctx: ServiceContext,
  orgId: string,
  mode: Mode,
  role: Create['deviceRole'],
  watch: Watch,
  id?: string,
) {
  if (role === 'scan') return;
  if (
    !watch ||
    (role === 'customer' && watch.allOrg) ||
    (!watch.allOrg && !watch.scannerIds.length) ||
    watch.scannerIds.includes(id ?? '')
  )
    throw new ValidationError(
      'Choose the scanners this screen should follow.',
      [],
      'SCANNER_WATCH_INVALID',
    );
  const ids = [...new Set(watch.scannerIds)];
  if ((await watchedScanners(ctx.env.DB, orgId, mode, ids)).length !== ids.length)
    throw new NotFoundError('A watched scanner is unavailable.', 'SCANNER_WATCH_NOT_FOUND');
}

function conflict(error: unknown): never {
  const info = classifyD1Error(error);
  if (info?.kind === 'unique' && /scanners\.name|scanners_org_name/.test(info.detail))
    throw new ConflictError('Another scanner already has that name.', 'SCANNER_NAME_TAKEN');
  if (info?.kind === 'unique')
    throw new ConflictError(
      'A setup with this name or admin already exists.',
      'SCANNER_SETUP_EXISTS',
    );
  throw error;
}

export async function createSetup(
  ctx: ServiceContext,
  userId: string,
  mode: Mode,
  input: Create,
  origin: string,
  authority: TenantPassWrite,
  enrollment?: DeviceEnrollment,
  parent?: ScanningSessionRow,
) {
  const { orgId, kind, deviceRole } = input;
  if (
    enrollment &&
    (!parent ||
      parent.id !== enrollment.sessionId ||
      parent.org_id !== orgId ||
      parent.mode !== mode)
  )
    throw new ConflictError(
      'This session changed. Reload and try again.',
      'SCANNING_SESSION_CHANGED',
    );
  if (!(await orgIsActive(ctx.env.DB, orgId)))
    throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  roleAllowed(kind, deviceRole);
  if (input.adminUserId) {
    // An admin setup is the caller's own; naming another user would expose their name and email.
    if (input.adminUserId !== userId)
      throw new ValidationError(
        'An admin setup belongs to the admin who creates it.',
        [{ path: 'adminUserId', message: 'Use your own account.' }],
        'SCANNER_ADMIN_USER',
      );
    const owner = await getUser(ctx.env.DB, input.adminUserId);
    if (owner?.status !== 'active')
      throw new NotFoundError('Admin user not found.', 'USER_NOT_FOUND');
    if (kind !== 'device')
      throw new ValidationError('Admin sign-in uses a browser device.', [], 'SCANNER_ADMIN_ROLE');
  }
  if (!enrollment) await checkWatch(ctx, orgId, mode, deviceRole, input.watch);
  // A device joining a session inherits its templates: archived ones already there stay usable.
  const attached = parent ? acceptedTemplateIds(parent.accepts) : [];
  const accepts = input.accepts
    ? await checkAccepts(ctx, orgId, mode, input.accepts, attached)
    : null;
  const settings = ScannerSettingsSchema.parse({
    ...DEFAULT_SETTINGS,
    ...input.settings,
    acceptAllTemplates: accepts === null,
  });
  if (settings.checkIn?.eventId)
    await checkAccepts(ctx, orgId, mode, { eventId: settings.checkIn.eventId });
  const now = ctx.clock.now();
  const id = ctx.ids.id();
  const g = adminGrant(
    ctx,
    'org_mode.scan.setup.create',
    userId,
    authority,
    orgId,
    [
      ...(parent ? [sessionEpoch(parent.id, parent.config_epoch)] : []),
      ...eventsOpen([accepts?.eventId, settings.checkIn?.eventId]),
      ...scopeTemplatesUsable(accepts?.templateIds ?? [], attached),
    ],
    SETUP_CODES,
    id,
  );
  addScannerInsert(g, {
    id,
    kind,
    deviceRole,
    name: input.name,
    eventId: accepts?.eventId ?? null,
    settings: JSON.stringify(settings),
    timeZone: input.timeZone,
    expiresAt: kind === 'terminal' ? now + TERMINAL_TTL_MS : null,
    createdBy: userId,
    now,
  });
  addScannerTemplates(g, id, accepts?.templateIds ?? []);
  addSetupInsert(g, id, mode, input.adminUserId ?? null, input.watch);
  addEnrollment(ctx, g, id, userId, input, settings, enrollment);
  g.add(
    audited(g, ctx, {
      orgId,
      actorType: 'user',
      actorId: userId,
      action: 'scanner.setup_create',
      targetType: 'scanner',
      targetId: id,
      detail: { kind, deviceRole, adminSession: !!input.adminUserId },
    }),
  );
  try {
    await g.commit();
  } catch (error) {
    conflict(error);
  }
  const pairing =
    !input.adminUserId && kind !== 'terminal'
      ? await createPairing(ctx, userId, await loadScanner(ctx, id), origin, authority)
      : null;
  return { ...(await setupView(ctx, id)), pairing };
}

export async function updateSetup(
  ctx: ServiceContext,
  userId: string,
  id: string,
  input: Update,
  authority: TenantPassWrite,
) {
  const row = await loadScanner(ctx, id, authority.mode);
  await assertStandaloneSession(ctx, row.orgId, id);
  const [device, parent] = await Promise.all([
    scanningDeviceRow(ctx.env.DB, row.orgId, id),
    scanningSessionForDevice(ctx.env.DB, row.orgId, id),
  ]);
  if (!!device !== !!parent || (parent && parent.id !== id))
    throw new ConflictError(
      'This scanner changed. Reload its settings and try again.',
      'SCANNER_CHANGED',
    );
  const role = input.deviceRole ?? row.deviceRole;
  const changingWatch = input.deviceRole !== undefined || input.watch !== undefined;
  const meta = changingWatch ? await setupMeta(ctx.env.DB, row.orgId, id) : null;
  const watch = input.watch === undefined ? watchOf(meta) : input.watch;
  if (input.deviceRole !== undefined) roleAllowed(row.kind, role);
  if (changingWatch) await checkWatch(ctx, row.orgId, row.mode, role, watch, id);
  const accepts = input.accepts
    ? await checkAccepts(ctx, row.orgId, row.mode, input.accepts, row.templateIds)
    : null;
  const settings =
    input.settings !== undefined || input.accepts !== undefined
      ? ScannerSettingsSchema.parse({
          ...requireScannerSettings(row.settings),
          ...input.settings,
          ...(input.accepts === undefined ? {} : { acceptAllTemplates: input.accepts === null }),
        })
      : null;
  const parentSettings =
    parent && settings
      ? ScannerSettingsSchema.parse({
          ...requireScannerSettings(parent.settings),
          ...input.settings,
          ...(input.accepts === undefined ? {} : { acceptAllTemplates: input.accepts === null }),
        })
      : null;
  if (input.settings?.checkIn?.eventId)
    await checkAccepts(ctx, row.orgId, row.mode, { eventId: input.settings.checkIn.eventId });
  const now = ctx.clock.now();
  const g = adminGrant(
    ctx,
    'org_mode.scan.setup.update',
    userId,
    authority,
    row.orgId,
    [
      scannerEpoch(id, row.configEpoch),
      ...(parent ? [sessionEpoch(parent.id, parent.config_epoch)] : []),
      ...eventsOpen([accepts?.eventId, input.settings?.checkIn?.eventId]),
      ...scopeTemplatesUsable(accepts?.templateIds ?? [], row.templateIds),
    ],
    SETUP_CODES,
    id,
  );
  addScannerPatch(
    g,
    id,
    {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(settings ? { settings: JSON.stringify(settings) } : {}),
      ...(accepts ? { eventId: accepts.eventId } : {}),
    },
    now,
  );
  if (input.deviceRole !== undefined) addDeviceRole(g, id, row.deviceRole, role, now);
  if (input.accepts === null) addSetupAcceptsClear(g, id, now);
  if (input.accepts !== undefined) replaceScannerTemplates(g, id, accepts?.templateIds ?? []);
  if (changingWatch) addSetupWatch(g, id, role === 'scan' ? null : watch);
  if (parent)
    addScannerPatchSessionSync(
      g,
      id,
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(parentSettings ? { settings: JSON.stringify(parentSettings) } : {}),
        ...(input.accepts === undefined
          ? {}
          : { accepts: input.accepts === null ? null : JSON.stringify(input.accepts) }),
      },
      now,
    );
  g.add(
    audited(g, ctx, {
      orgId: row.orgId,
      actorType: 'user',
      actorId: userId,
      action: 'scanner.setup_update',
      targetType: 'scanner',
      targetId: id,
      detail: { deviceRole: role },
    }),
  );
  try {
    await g.commit();
  } catch (error) {
    conflict(error);
  }
  await kickScreen(ctx, row.orgId, row.mode, id);
  return setupView(ctx, id);
}
