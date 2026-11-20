import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import { CreateScanEventSchema } from '../../../shared/contracts/index.ts';
import type {
  TemplateScanSetup,
  TemplateScanSetupBodySchema,
} from '../../../shared/contracts/scan-template-setup.ts';
import { CreateScanningSessionSchema } from '../../../shared/contracts/scanning-sessions.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { resolveTemplate } from '../passes/builder.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { getTemplate } from '../templates/repo.ts';
import { storedAdmits } from './admits.ts';
import { captureEventAuthority } from './events.ts';
import { archiveEvent, createEvent } from './events-mutations.ts';
import {
  listedEventValues,
  ownEventValues,
  sessionScanningTemplate,
  setupEvent,
} from './repo-template-setup.ts';
import { captureConsoleSessionCountAuthority } from './scanning-session-dto.ts';
import {
  createScanningSession,
  loadScanningSession,
  updateScanningSession,
} from './scanning-sessions.ts';
import {
  checkInOf,
  eventSource,
  MAX_EVENTS,
  type PlannedEvent,
  plainText,
  planEvents,
} from './template-setup-plan.ts';

type Input = z.infer<typeof TemplateScanSetupBodySchema>;
type Made = TemplateScanSetup['events'][number];

/**
 * Scan passes for one template: a live session that admits the template and the upcoming events
 * its issued passes name. Idempotent and safe to repeat: a live session (active or paused) that
 * already scans the template is reused and only gains events it lacks. One session per template
 * is held by a unique index, so two calls at once end with one session and one set of events.
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
  const template = await loadTemplate(ctx, orgId, templateId);
  const source = eventSource(template.manifest);
  const values = [
    ...(source.own ? await ownEventValues(db, orgId, mode, templateId, source.own) : []),
    ...(source.list ? await listedEventValues(db, orgId, mode, templateId, source.list) : []),
  ];
  const planned = planEvents(templateId, source, values, ctx.clock.now());
  const eventStyle = source.own !== null || source.list !== null;
  const timeZone = input.timeZone ?? planned.find((e) => e.timeZone)?.timeZone ?? 'UTC';
  const read = await tenantAuthorityOf(ctx, auth, orgId, 'scanning:read');
  const countAuthority = await captureConsoleSessionCountAuthority(ctx, auth, read);

  const ensureEvent = async (e: PlannedEvent): Promise<Made | null> => {
    const found = await setupEvent(db, orgId, mode, e.key);
    if (found) return { id: found.id, name: e.name, created: false };
    const body = CreateScanEventSchema.safeParse({
      orgId,
      name: e.name,
      templateIds: [templateId],
      opensAt: e.opensAt,
      closesAt: e.closesAt,
      timeZone: e.timeZone ?? timeZone,
      note: e.venue,
      match: e.matchInput ? { input: e.matchInput, values: [e.name] } : null,
    });
    if (!body.success) {
      ctx.log.warn('scan.template_setup.event_skipped', { orgId, code: 'EVENT_INVALID' });
      return null;
    }
    try {
      const made = await createEvent(
        ctx,
        auth.userId,
        mode,
        body.data,
        await captureEventAuthority(ctx, auth, authority),
        e.key,
      );
      return { id: made.id, name: made.name, created: true };
    } catch (error) {
      // A concurrent call may hold the key: take its event. Anything else is the caller's error.
      const winner = await setupEvent(db, orgId, mode, e.key);
      if (!winner) throw error;
      return { id: winner.id, name: e.name, created: false };
    }
  };

  const addToExisting = async (sessionId: string): Promise<TemplateScanSetup> => {
    const row = await loadScanningSession(ctx, sessionId, mode, orgId);
    const admits = storedAdmits(row.accepts) ?? { templateIds: [], eventIds: [] };
    const ids = new Set(admits.eventIds);
    const added: Made[] = [];
    for (const e of planned) {
      if (ids.size + added.length >= MAX_EVENTS) break;
      const known = await setupEvent(db, orgId, mode, e.key);
      if (known && ids.has(known.id)) continue;
      const made = await ensureEvent(e);
      if (made && !ids.has(made.id)) added.push(made);
    }
    if (added.length > 0)
      await updateScanningSession(
        ctx,
        auth.userId,
        sessionId,
        {
          accepts: {
            templateIds: admits.templateIds,
            eventIds: [...ids, ...added.map((e) => e.id)],
          },
        },
        authority,
        countAuthority,
      );
    return {
      session: { id: row.id, name: row.name },
      created: false,
      events: added,
      noEvents: eventStyle && ids.size + added.length === 0,
    };
  };

  const existing = await sessionScanningTemplate(db, orgId, mode, templateId);
  if (existing) return addToExisting(existing.id);

  const events: Made[] = [];
  for (const e of planned) {
    const made = await ensureEvent(e);
    if (made) events.push(made);
  }
  try {
    const checkIn = checkInOf(template.manifest);
    const body = CreateScanningSessionSchema.parse({
      orgId,
      name: plainText(template.manifest.name, 80) ?? 'Scanning',
      timeZone,
      accepts:
        events.length > 0
          ? { templateIds: [templateId], eventIds: events.map((e) => e.id) }
          : { templateIds: [templateId] },
      ...(checkIn ? { settings: { checkIn } } : {}),
    });
    const session = await createScanningSession(
      ctx,
      auth.userId,
      mode,
      body,
      authority,
      countAuthority,
      templateId,
    );
    return {
      session: { id: session.id, name: session.name },
      created: true,
      events,
      noEvents: eventStyle && events.length === 0,
    };
  } catch (error) {
    const winner = await sessionScanningTemplate(db, orgId, mode, templateId);
    if (winner) {
      ctx.log.info('scan.template_setup.raced', { orgId, code: 'SETUP_RACED' });
      return addToExisting(winner.id);
    }
    // Nothing holds these events now: archive what this call made so none is left stray.
    for (const e of events.filter((made) => made.created)) {
      try {
        await archiveEvent(
          ctx,
          auth.userId,
          e.id,
          await captureEventAuthority(ctx, auth, authority),
        );
      } catch (cleanup) {
        ctx.log.error('scan.template_setup.cleanup_failed', {
          orgId,
          code: 'SETUP_CLEANUP_FAILED',
          error: cleanup,
        });
      }
    }
    throw error;
  }
}

async function loadTemplate(ctx: ServiceContext, orgId: string, templateId: string) {
  const row = await getTemplate(ctx.env.DB, templateId);
  if (!row || row.status === 'deleted' || (row.orgId !== null && row.orgId !== orgId))
    throw new NotFoundError('Template not found.', 'TEMPLATE_NOT_FOUND');
  if (row.blueprint)
    throw new ValidationError(
      'Make a template from this blueprint first.',
      [],
      'BLUEPRINT_NOT_SCANNABLE',
    );
  if (!row.activeVersion)
    throw new ConflictError('Release the template first.', 'TEMPLATE_NOT_RELEASED');
  return resolveTemplate(ctx, orgId, templateId);
}
