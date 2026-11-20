import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import type {
  TemplateScanSetup,
  TemplateScanSetupBodySchema,
} from '../../../shared/contracts/scan-setups.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { ConflictError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { resolveTemplate } from '../passes/builder.ts';
import { type TenantPassWrite, tenantAuthorityOf } from '../passes/http.ts';
import { captureEventAuthority } from './events.ts';
import { createEvent } from './events-mutations.ts';
import { adminGrant, audited } from './repo-admin-grant.ts';
import {
  claimSetup,
  eventLike,
  reclaimSetup,
  releaseSetup,
  sessionScanningTemplate,
} from './repo-template-setup.ts';
import { captureConsoleSessionCountAuthority } from './scanning-session-dto.ts';
import { createScanningSession, loadScanningSession } from './scanning-sessions.ts';
import { hoursForEvents, planTemplateScan } from './template-setup-plan.ts';

type Input = z.infer<typeof TemplateScanSetupBodySchema>;

const WAIT_MS = 200;
const ATTEMPTS = 25;
/** A holder that has not finished by now is gone. A setup takes a few writes. */
const STALE_MS = 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One scanning setup for a template: the events its own data lists and an active session that
 * admits them and the template, with the session left to edit. Idempotent: an active session that
 * already admits the template (or an open event of it) is returned and nothing is made.
 */
export async function setupTemplateScan(
  ctx: ServiceContext,
  auth: SessionAuth,
  mode: Mode,
  templateId: string,
  input: Input,
): Promise<TemplateScanSetup> {
  const { orgId } = input;
  const db = ctx.env.DB;
  const authority = await tenantAuthorityOf(ctx, auth, orgId, 'scanning:manage');
  const existing = async (): Promise<TemplateScanSetup | null> => {
    const found = await sessionScanningTemplate(db, orgId, mode, templateId);
    if (!found) return null;
    const row = await loadScanningSession(ctx, found.id, mode, orgId);
    return { session: { id: row.id, name: row.name }, created: false, events: [], undated: [] };
  };
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const done = await existing();
    if (done) return done;
    const reservation = ctx.ids.id();
    if (await claimSetup(db, orgId, mode, templateId, reservation, ctx.clock.now())) {
      try {
        return (await existing()) ?? (await build(ctx, auth, mode, templateId, input, authority));
      } finally {
        await releaseSetup(db, orgId, mode, templateId, reservation);
      }
    }
    if (attempt === 0) await reclaimSetup(db, orgId, mode, templateId, ctx.clock.now() - STALE_MS);
    await sleep(WAIT_MS);
  }
  throw new ConflictError('Scanning is being set up. Try again.', 'SCAN_SETUP_BUSY');
}

async function build(
  ctx: ServiceContext,
  auth: SessionAuth,
  mode: Mode,
  templateId: string,
  input: Input,
  authority: TenantPassWrite,
): Promise<TemplateScanSetup> {
  const { orgId } = input;
  const template = await resolveTemplate(ctx, orgId, templateId);
  if (template.manifest.blueprint)
    throw new ValidationError(
      'Make a template from this blueprint first.',
      [],
      'BLUEPRINT_NOT_SCANNABLE',
    );
  const plan = planTemplateScan(template.manifest, template.passJson, ctx.clock.now());
  const timeZone = input.timeZone ?? plan.events[0]?.timeZone ?? 'UTC';
  const events: TemplateScanSetup['events'] = [];
  for (const e of plan.events) {
    const found = await eventLike(
      ctx.env.DB,
      orgId,
      mode,
      templateId,
      e.name,
      e.opensAt,
      e.closesAt,
    );
    if (found) {
      events.push({ id: found.id, name: e.name, created: false });
      continue;
    }
    const made = await createEvent(
      ctx,
      auth.userId,
      mode,
      {
        orgId,
        name: e.name,
        templateIds: [templateId],
        opensAt: e.opensAt,
        closesAt: e.closesAt,
        timeZone: e.timeZone ?? timeZone,
        note: e.venue,
      },
      await captureEventAuthority(ctx, auth, authority),
    );
    events.push({ id: made.id, name: made.name, created: true });
  }
  const read = await tenantAuthorityOf(ctx, auth, orgId, 'scanning:read');
  const session = await createScanningSession(
    ctx,
    auth.userId,
    mode,
    {
      orgId,
      name: template.manifest.name.slice(0, 80),
      timeZone,
      accepts:
        events.length > 0
          ? { templateIds: [templateId], eventIds: events.map((e) => e.id) }
          : { templateIds: [templateId] },
      ...(plan.checkIn ? { settings: { checkIn: plan.checkIn } } : {}),
      hours: hoursForEvents(plan.events, timeZone),
    },
    authority,
    await captureConsoleSessionCountAuthority(ctx, auth, read),
  );
  const g = adminGrant(
    ctx,
    'org_mode.scan.template_setup',
    auth.userId,
    authority,
    orgId,
    [],
    undefined,
    session.id,
  );
  audited(g, ctx, {
    orgId,
    actorType: 'user',
    actorId: auth.userId,
    action: 'scan.template_setup',
    targetType: 'template',
    targetId: templateId,
    detail: { mode, sessionId: session.id, events: events.filter((e) => e.created).length },
  });
  await g.commit();
  return {
    session: { id: session.id, name: session.name },
    created: true,
    events,
    undated: plan.undated,
  };
}
