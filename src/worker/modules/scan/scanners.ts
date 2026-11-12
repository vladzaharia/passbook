import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import {
  type CreateScannerSchema,
  ScannerSettingsSchema,
  type UpdateScannerSchema,
} from '../../../shared/contracts/index.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { orgIsActive } from '../orgs/repo.ts';
import type { TenantPassWrite } from '../passes/http.ts';
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
  sessionEpoch,
  templatesUsable,
} from './repo-admin-grant.ts';
import { addScannerTemplates, replaceScannerTemplates } from './repo-admin-unguarded.ts';
import { addScannerPatchSessionSync } from './repo-scanner-configuration-sync.ts';
import { addScannerInsert, addScannerPatch } from './repo-scanners.ts';
import { scanningDeviceRow } from './repo-scanning-devices.ts';
import { scanningSessionForDevice } from './repo-scanning-sessions.ts';
import { nameTaken } from './scanner-name.ts';
import { checkAccepts, requireScannerSettings } from './scanner-validation.ts';
import { loadScanner, scannerView } from './scanner-views.ts';
import { addEnrollment } from './scanning-enrollment.ts';

/** A scanner edit that lost a race answers 409 and the console refetches (no unpairing). */
export const SCANNER_CODES = { config: 'SCANNER_CHANGED', lineage: 'SCANNER_CHANGED' } as const;

export async function createScanner(
  ctx: ServiceContext,
  userId: string,
  mode: Mode,
  input: z.infer<typeof CreateScannerSchema>,
  origin: string,
  authority: TenantPassWrite,
) {
  const db = ctx.env.DB;
  if (!(await orgIsActive(db, input.orgId)))
    throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  const accepts = await checkAccepts(ctx, input.orgId, mode, input.accepts);
  const settings = ScannerSettingsSchema.parse({ ...DEFAULT_SETTINGS, ...input.settings });
  if (settings.checkIn?.eventId)
    await checkAccepts(ctx, input.orgId, mode, { eventId: settings.checkIn.eventId });
  const now = ctx.clock.now();
  const id = ctx.ids.id();
  const g = adminGrant(
    ctx,
    'org_mode.scan.scanner.create',
    userId,
    authority,
    input.orgId,
    [
      ...eventsOpen([accepts.eventId, settings.checkIn?.eventId]),
      ...templatesUsable(accepts.templateIds),
    ],
    SCANNER_CODES,
    id,
  );
  addScannerInsert(g, {
    id,
    kind: input.kind,
    name: input.name,
    eventId: accepts.eventId,
    settings: JSON.stringify(settings),
    timeZone: input.timeZone,
    expiresAt: input.kind === 'terminal' ? now + TERMINAL_TTL_MS : null,
    createdBy: userId,
    now,
  });
  addScannerTemplates(g, id, accepts.templateIds);
  addEnrollment(ctx, g, id, userId, { ...input, deviceRole: 'scan' }, settings);
  g.add(
    audited(g, ctx, {
      orgId: input.orgId,
      actorType: 'user',
      actorId: userId,
      action: 'scanner.create',
      targetType: 'scanner',
      targetId: id,
      detail: { kind: input.kind, mode, accepts: accepts.eventId ? 'event' : 'templates' },
    }),
  );
  try {
    await g.commit();
  } catch (error) {
    nameTaken(error);
  }
  const row = await loadScanner(ctx, id);
  const pairing =
    input.kind === 'device' ? await createPairing(ctx, userId, row, origin, authority) : null;
  return { ...(await scannerView(ctx, id)), pairing };
}

export async function updateScanner(
  ctx: ServiceContext,
  userId: string,
  id: string,
  input: z.infer<typeof UpdateScannerSchema>,
  authority: TenantPassWrite,
) {
  const db = ctx.env.DB;
  const row = await loadScanner(ctx, id, authority.mode);
  await assertStandaloneSession(ctx, row.orgId, id);
  const [device, parent] = await Promise.all([
    scanningDeviceRow(db, row.orgId, id),
    scanningSessionForDevice(db, row.orgId, id),
  ]);
  if (!!device !== !!parent || (parent && parent.id !== id))
    throw new ConflictError(
      'This scanner changed. Reload its settings and try again.',
      'SCANNER_CHANGED',
    );
  const accepts = input.accepts
    ? await checkAccepts(ctx, row.orgId, row.mode, input.accepts)
    : null;
  const settings =
    input.settings !== undefined || accepts
      ? ScannerSettingsSchema.parse({
          ...requireScannerSettings(row.settings),
          ...input.settings,
          ...(accepts ? { acceptAllTemplates: false } : {}),
        })
      : null;
  const parentSettings =
    parent && settings
      ? ScannerSettingsSchema.parse({
          ...requireScannerSettings(parent.settings),
          ...input.settings,
          ...(accepts ? { acceptAllTemplates: false } : {}),
        })
      : null;
  if (input.settings?.checkIn?.eventId)
    await checkAccepts(ctx, row.orgId, row.mode, { eventId: input.settings.checkIn.eventId });
  const now = ctx.clock.now();
  const g = adminGrant(
    ctx,
    'org_mode.scan.scanner.update',
    userId,
    authority,
    row.orgId,
    [
      scannerEpoch(id, row.configEpoch),
      ...(parent ? [sessionEpoch(parent.id, parent.config_epoch)] : []),
      ...eventsOpen([accepts?.eventId, input.settings?.checkIn?.eventId]),
      ...templatesUsable(accepts?.templateIds ?? []),
    ],
    SCANNER_CODES,
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
  if (accepts) replaceScannerTemplates(g, id, accepts.templateIds);
  if (parent)
    addScannerPatchSessionSync(
      g,
      id,
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(parentSettings ? { settings: JSON.stringify(parentSettings) } : {}),
        ...(accepts
          ? {
              accepts: JSON.stringify(
                accepts.eventId
                  ? { eventId: accepts.eventId }
                  : { templateIds: accepts.templateIds },
              ),
            }
          : {}),
      },
      now,
    );
  g.add(
    audited(g, ctx, {
      orgId: row.orgId,
      actorType: 'user',
      actorId: userId,
      action: 'scanner.update',
      targetType: 'scanner',
      targetId: id,
      detail: {
        fields: [
          ...(input.name === undefined ? [] : ['name']),
          ...(input.accepts ? ['accepts'] : []),
          ...Object.keys(input.settings ?? {}).map((k) => `settings.${k}`),
        ],
      },
    }),
  );
  try {
    await g.commit();
  } catch (error) {
    nameTaken(error);
  }
  if (row.deviceRole !== 'scan') await kickScreen(ctx, row.orgId, row.mode, id);
  return scannerView(ctx, id);
}
