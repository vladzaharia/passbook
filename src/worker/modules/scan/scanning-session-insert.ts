import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import {
  type CreateScanningSessionSchema,
  ScanningSessionSettingsSchema,
} from '../../../shared/contracts/scanning-sessions.ts';
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
import { checkAccepts } from './scanner-validation.ts';
import { newTiming } from './session-hours-write.ts';
import { eventOnly, sessionZoneChecks } from './session-zones.ts';

export const SESSION_CODES = {
  config: 'SCANNING_SESSION_CHANGED',
  lineage: 'SCANNING_SESSION_CHANGED',
  stale: 'SCANNING_SESSION_CHANGED',
} as const;

/** The write of a new session, for a console session or a key; the caller answers with the view it may show. */
export async function insertScanningSession(
  ctx: ServiceContext,
  actorId: string,
  mode: Mode,
  input: z.infer<typeof CreateScanningSessionSchema>,
  authority: TenantPassWrite,
  setupTemplateId?: string,
): Promise<string> {
  if (!(await orgIsActive(ctx.env.DB, input.orgId)))
    throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  const accepts = input.accepts ? await checkAccepts(ctx, input.orgId, mode, input.accepts) : null;
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
    await checkAccepts(ctx, input.orgId, mode, { eventId: settings.checkIn.eventId });
  const zoneChecks = await sessionZoneChecks(ctx, input.orgId, zoneIds, eventOnly(accepts));
  const now = ctx.clock.now();
  const id = ctx.ids.id();
  const g = adminGrant(
    ctx,
    'org_mode.scan.session.create',
    actorId,
    authority,
    input.orgId,
    [
      ...eventsOpen([...(accepts?.eventIds ?? []), settings.checkIn?.eventId]),
      ...templatesUsable(accepts?.templateIds ?? []),
      ...zoneChecks,
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
      accepts: accepts ? admitsJson(accepts.admits) : null,
      settings: JSON.stringify(settings),
      time_zone: input.timeZone,
      ...newTiming(input.timeZone, input.hours ?? null, now),
      created_at: now,
      updated_at: now,
      ...(setupTemplateId ? { setup_template_id: setupTemplateId } : {}),
    },
    createdByOf(authority, actorId),
  );
  if (zoneIds.length > 0) addSessionZones(g, id, zoneIds, false);
  g.add(
    audited(g, ctx, {
      orgId: input.orgId,
      ...adminActorOf(authority, actorId),
      action: setupTemplateId ? 'scan.template_setup' : 'scanning.session_create',
      targetType: 'scanning_session',
      targetId: id,
      detail: setupTemplateId ? { mode, templateId: setupTemplateId } : { mode },
    }),
  );
  await g.commit();
  return id;
}
