import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import { ScannerSettingsSchema } from '../../../shared/contracts/scan.ts';
import type {
  CreateScannerSetupSchema,
  UpdateScannerSetupSchema,
} from '../../../shared/contracts/scan-setups.ts';
import type { ScannerListQuerySchema } from '../../../shared/contracts/scanners.ts';
import { batch, classifyD1Error } from '../../platform/db.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';
import { orgIsActive } from '../orgs/repo.ts';
import { getUser } from '../users/repo.ts';
import { ADMIN_SETTINGS } from './actor.ts';
import { DEFAULT_SETTINGS, parseSettings } from './dto-console.ts';
import { kickScreen } from './live.ts';
import { createPairing } from './pairing.ts';
import { TERMINAL_TTL_MS } from './pairing-token.ts';
import {
  addTemplatesStmts,
  insertScannerStmt,
  replaceTemplatesStmts,
  updateScannerStmt,
} from './repo-scanners.ts';
import {
  adminSetupId,
  clearSetupAcceptsStmt,
  insertSetupStmt,
  setDeviceRoleStmt,
  setSetupWatchStmt,
  setupMeta,
  setupMetas,
  watchedScanners,
  watchOf,
} from './repo-setups.ts';
import { checkAccepts, listScanners, loadScanner, scannerView } from './scanners.ts';

type Create = z.infer<typeof CreateScannerSetupSchema>;
type Update = z.infer<typeof UpdateScannerSetupSchema>;
type Watch = Create['watch'];

export async function listSetups(
  ctx: ServiceContext,
  mode: Mode,
  query: z.infer<typeof ScannerListQuerySchema>,
) {
  const page = await listScanners(ctx, mode, query);
  const metadata = await setupMetas(
    ctx.env.DB,
    query.orgId ?? null,
    page.items.map((s) => s.id),
  );
  return {
    ...page,
    items: page.items.map((scanner) => {
      const meta = metadata.find((m) => m.scanner_id === scanner.id);
      return {
        ...scanner,
        adminSession: meta?.admin_session === 1,
        adminUser: meta?.admin_user_id
          ? { id: meta.admin_user_id, name: meta.admin_name ?? 'Admin' }
          : null,
        watch: watchOf(meta ?? null),
      };
    }),
  };
}

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

export async function setupView(ctx: ServiceContext, id: string) {
  const scanner = await scannerView(ctx, id);
  const meta = await setupMeta(ctx.env.DB, scanner.orgId, id);
  return {
    ...scanner,
    adminSession: meta?.admin_session === 1,
    adminUser: meta?.admin_user_id
      ? { id: meta.admin_user_id, name: meta.admin_name ?? 'Admin' }
      : null,
    watch: watchOf(meta),
  };
}

export async function createSetup(
  ctx: ServiceContext,
  userId: string,
  mode: Mode,
  input: Create,
  origin: string,
) {
  const { orgId, kind, deviceRole } = input;
  if (!(await orgIsActive(ctx.env.DB, orgId)))
    throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  roleAllowed(kind, deviceRole);
  if (input.adminUserId) {
    const owner = await getUser(ctx.env.DB, input.adminUserId);
    if (owner?.status !== 'active')
      throw new NotFoundError('Admin user not found.', 'USER_NOT_FOUND');
    if (kind !== 'device' || deviceRole !== 'scan')
      throw new ValidationError('Admin sessions use a scanner setup.', [], 'SCANNER_ADMIN_ROLE');
  }
  await checkWatch(ctx, orgId, mode, deviceRole, input.watch);
  const accepts = input.accepts ? await checkAccepts(ctx, orgId, mode, input.accepts) : null;
  const settings = ScannerSettingsSchema.parse({
    ...DEFAULT_SETTINGS,
    ...input.settings,
    acceptAllTemplates: accepts === null,
  });
  if (settings.checkIn?.eventId)
    await checkAccepts(ctx, orgId, mode, { eventId: settings.checkIn.eventId });
  const now = ctx.clock.now();
  const id = ctx.ids.id();
  try {
    await batch(ctx.env.DB, [
      insertScannerStmt(ctx.env.DB, {
        id,
        orgId,
        mode,
        kind,
        deviceRole,
        name: input.name,
        eventId: accepts?.eventId ?? null,
        settings: JSON.stringify(settings),
        timeZone: input.timeZone,
        expiresAt: kind === 'terminal' ? now + TERMINAL_TTL_MS : null,
        createdBy: userId,
        now,
      }),
      ...addTemplatesStmts(ctx.env.DB, id, accepts?.templateIds ?? []),
      insertSetupStmt(ctx.env.DB, id, orgId, mode, input.adminUserId ?? null, input.watch),
      auditStmt(ctx.env.DB, ctx, {
        orgId,
        actorType: 'user',
        actorId: userId,
        action: 'scanner.setup_create',
        targetType: 'scanner',
        targetId: id,
        detail: { kind, deviceRole, adminSession: !!input.adminUserId },
      }),
    ]);
  } catch (error) {
    conflict(error);
  }
  const pairing =
    !input.adminUserId && kind !== 'terminal'
      ? await createPairing(ctx, userId, await loadScanner(ctx, id), origin)
      : null;
  return { ...(await setupView(ctx, id)), pairing };
}

export async function updateSetup(ctx: ServiceContext, userId: string, id: string, input: Update) {
  const row = await loadScanner(ctx, id);
  const meta = await setupMeta(ctx.env.DB, row.orgId, id);
  const role = input.deviceRole ?? row.deviceRole;
  roleAllowed(row.kind, role);
  if (meta?.admin_session && role !== 'scan')
    throw new ValidationError('Admin sessions use a scanner setup.', [], 'SCANNER_ADMIN_ROLE');
  const watch = input.watch === undefined ? watchOf(meta) : input.watch;
  await checkWatch(ctx, row.orgId, row.mode, role, watch, id);
  const accepts = input.accepts
    ? await checkAccepts(ctx, row.orgId, row.mode, input.accepts)
    : null;
  const settings = ScannerSettingsSchema.parse({
    ...parseSettings(row.settings),
    ...input.settings,
    ...(input.accepts === undefined ? {} : { acceptAllTemplates: input.accepts === null }),
  });
  if (settings.checkIn?.eventId)
    await checkAccepts(ctx, row.orgId, row.mode, { eventId: settings.checkIn.eventId });
  const now = ctx.clock.now();
  try {
    await batch(ctx.env.DB, [
      updateScannerStmt(
        ctx.env.DB,
        id,
        {
          ...(input.name === undefined ? {} : { name: input.name }),
          settings: JSON.stringify(settings),
          ...(accepts ? { eventId: accepts.eventId } : {}),
        },
        now,
      ),
      setDeviceRoleStmt(ctx.env.DB, row.orgId, id, role, now),
      ...(input.accepts === null ? [clearSetupAcceptsStmt(ctx.env.DB, row.orgId, id)] : []),
      ...(input.accepts === undefined
        ? []
        : replaceTemplatesStmts(ctx.env.DB, id, accepts?.templateIds ?? [])),
      setSetupWatchStmt(ctx.env.DB, row.orgId, id, role === 'scan' ? null : watch),
      auditStmt(ctx.env.DB, ctx, {
        orgId: row.orgId,
        actorType: 'user',
        actorId: userId,
        action: 'scanner.setup_update',
        targetType: 'scanner',
        targetId: id,
        detail: { deviceRole: role },
      }),
    ]);
  } catch (error) {
    conflict(error);
  }
  await kickScreen(ctx, row.orgId, row.mode, id);
  return setupView(ctx, id);
}

export async function startAdminSetup(
  ctx: ServiceContext,
  userId: string,
  mode: Mode,
  input: { orgId: string; timeZone: string },
  origin: string,
) {
  if (!(await orgIsActive(ctx.env.DB, input.orgId)))
    throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  let id = await adminSetupId(ctx.env.DB, input.orgId, mode, userId);
  if (!id) {
    const user = await getUser(ctx.env.DB, userId);
    try {
      const made = await createSetup(
        ctx,
        userId,
        mode,
        {
          ...input,
          name: `Admin ${user?.name ?? userId}`.slice(0, 40),
          kind: 'device',
          deviceRole: 'scan',
          adminUserId: userId,
          accepts: null,
          settings: { ...ADMIN_SETTINGS, flow: 'auto', reader: 'none' },
        },
        origin,
      );
      id = made.id;
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      id = await adminSetupId(ctx.env.DB, input.orgId, mode, userId);
      if (!id) throw error;
    }
  }
  const row = await loadScanner(ctx, id);
  return { setupId: id, orgId: row.orgId, mode: row.mode, timeZone: row.timeZone };
}
