import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { ScannerSettings } from '../../../shared/contracts/scan.ts';
import {
  type CreateScanningSessionSchema,
  ScanningSessionSettingsSchema,
} from '../../../shared/contracts/scanning-sessions.ts';
import type { Grant } from '../../platform/authority.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { orgIsActive } from '../orgs/repo.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { admitsJson } from './admits.ts';
import { DEFAULT_SETTINGS } from './dto-console.ts';
import { savedOfflineSettings } from './offline-policy.ts';
import {
  adminActorOf,
  adminGrant,
  audited,
  createdByOf,
  eventsOpen,
  templatesUsable,
} from './repo-admin-grant.ts';
import { addScanningSessionInsert } from './repo-scanning-sessions.ts';
import { addSessionZones } from './repo-zones.ts';
import { type CheckedAdmits, checkAccepts } from './scanner-validation.ts';
import { newTiming } from './session-hours-write.ts';
import { eventOnly, sessionZoneChecks } from './session-zones.ts';
import { newCapture, type SetupCapture } from './setup-capture.ts';

export const SESSION_CODES = {
  config: 'SCANNING_SESSION_CHANGED',
  lineage: 'SCANNING_SESSION_CHANGED',
  stale: 'SCANNING_SESSION_CHANGED',
} as const;

export interface SessionPlan {
  id: string;
  input: z.infer<typeof CreateScanningSessionSchema>;
  accepts: CheckedAdmits | null;
  settings: ScannerSettings;
  checks: Check[];
  row: Parameters<typeof addScanningSessionInsert>[1];
  setupTemplateId?: string | undefined;
}

/**
 * The reads and rules of a session create: the org is active and the admitted events, templates
 * and zones are usable. An event or zone the batch creates earlier counts as usable and needs no
 * check, since a check runs before the batch's own writes. Nothing is written; the session joins
 * the capture so later plans may add devices to it.
 */
export async function planSession(
  ctx: ServiceContext,
  input: z.infer<typeof CreateScanningSessionSchema>,
  capture: SetupCapture,
  setupTemplateId?: string,
): Promise<SessionPlan> {
  const { orgId, mode } = capture;
  if (!(await orgIsActive(ctx.env.DB, input.orgId)))
    throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  const accepts = input.accepts
    ? await checkAccepts(ctx, input.orgId, mode, input.accepts, [], capture.events)
    : null;
  const zoneIds = input.zoneIds ?? [];
  const settings = savedOfflineSettings(
    ScanningSessionSettingsSchema.parse({
      ...DEFAULT_SETTINGS,
      lookup: true,
      showPhoto: true,
      ...input.settings,
      acceptAllTemplates: input.accepts === null,
    }),
    zoneIds.length,
  );
  if (settings.checkIn?.eventId)
    await checkAccepts(ctx, orgId, mode, { eventId: settings.checkIn.eventId }, [], capture.events);
  const zoneChecks = await sessionZoneChecks(
    ctx,
    input.orgId,
    zoneIds,
    eventOnly(accepts),
    undefined,
    capture.zones,
  );
  const stored = (id: string | null | undefined) => (id && capture.events.has(id) ? null : id);
  const now = ctx.clock.now();
  const id = ctx.ids.id();
  const row = {
    id,
    name: input.name,
    status: 'active' as const,
    accepts: accepts ? admitsJson(accepts.admits) : null,
    settings: JSON.stringify(settings),
    time_zone: input.timeZone,
    ...newTiming(input.timeZone, input.hours ?? null, now),
    created_at: now,
    updated_at: now,
    ...(setupTemplateId ? { setup_template_id: setupTemplateId } : {}),
  };
  capture.sessions.set(id, {
    ...row,
    org_id: input.orgId,
    org_name: '',
    mode,
    hold: null,
    config_epoch: 0,
  });
  return {
    id,
    input,
    accepts,
    settings,
    row,
    setupTemplateId,
    checks: [
      ...eventsOpen([...(accepts?.eventIds ?? []).map(stored), stored(settings.checkIn?.eventId)]),
      ...templatesUsable(accepts?.templateIds ?? []),
      ...zoneChecks,
    ],
  };
}

/** The session row, its zone links and its audit row. */
export function sessionStatements(
  g: Grant,
  ctx: ServiceContext,
  plan: SessionPlan,
  capture: SetupCapture,
): { id: string } {
  const { id, input, row, setupTemplateId } = plan;
  addScanningSessionInsert(g, row, createdByOf(capture.authority, capture.userId));
  const zoneIds = input.zoneIds ?? [];
  if (zoneIds.length > 0) addSessionZones(g, id, zoneIds, false);
  g.add(
    audited(g, ctx, {
      orgId: input.orgId,
      ...adminActorOf(capture.authority, capture.userId),
      action: setupTemplateId ? 'scan.template_setup' : 'scanning.session_create',
      targetType: 'scanning_session',
      targetId: id,
      detail: setupTemplateId
        ? { mode: capture.mode, templateId: setupTemplateId }
        : { mode: capture.mode },
    }),
  );
  return { id };
}

/** The write of a new session, for a console session or a key; the caller answers with the view it may show. */
export async function insertScanningSession(
  ctx: ServiceContext,
  actorId: string,
  mode: Mode,
  input: z.infer<typeof CreateScanningSessionSchema>,
  authority: TenantPassWrite,
  setupTemplateId?: string,
): Promise<string> {
  const capture = newCapture({ userId: actorId, authority, orgId: input.orgId, mode });
  const plan = await planSession(ctx, input, capture, setupTemplateId);
  const g = adminGrant(
    ctx,
    'org_mode.scan.session.create',
    actorId,
    authority,
    input.orgId,
    plan.checks,
    SESSION_CODES,
    plan.id,
  );
  sessionStatements(g, ctx, plan, capture);
  await g.commit();
  return plan.id;
}
