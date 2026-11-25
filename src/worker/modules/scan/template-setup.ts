import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import { CreateScanEventSchema } from '../../../shared/contracts/index.ts';
import { ScanSetupIntentSchema } from '../../../shared/contracts/scan-setup-intent.ts';
import type {
  TemplateScanSetup,
  TemplateScanSetupBodySchema,
} from '../../../shared/contracts/scan-template-setup.ts';
import type { ApiKeyAuth, SessionAuth } from '../../platform/auth.ts';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { resolveTemplate } from '../passes/builder.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { getTemplate } from '../templates/repo.ts';
import { storedAdmits } from './admits.ts';
import { readOrgTimeZone } from './repo-org-clock.ts';
import {
  listedEventValues,
  ownEventValues,
  sessionScanningTemplate,
  setupEvent,
  setupSession,
} from './repo-template-setup.ts';
import { loadScanningSession } from './scanning-sessions.ts';
import { planSetupIntent } from './setup-intent.ts';
import { applySetupPlan } from './setup-intent-apply.ts';
import { setupActor } from './template-setup-actor.ts';
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

const DAY = 86_400_000;

/**
 * Scan passes for one template: a live session that admits the template and the upcoming events
 * its issued passes name. Idempotent and safe to repeat: the live session (active or paused) that
 * already scans the template is reused, and only gains the events it lacks. One session per
 * template is held by a unique index, so two calls at once end with one session.
 */
export async function setupTemplateScan(
  ctx: ServiceContext,
  auth: SessionAuth | ApiKeyAuth,
  mode: Mode,
  templateId: string,
  input: Input,
): Promise<TemplateScanSetup> {
  const { orgId } = input;
  const db = ctx.env.DB;
  // A key bound to another org (or to none) finds no such org.
  if (auth.kind === 'api_key' && auth.orgId !== orgId)
    throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  const authority = await tenantAuthorityOf(ctx, auth, orgId, 'scanning:manage');
  const template = await loadTemplate(ctx, orgId, templateId);
  const source = eventSource(template.manifest);
  const now = ctx.clock.now();
  const [own, listed] = await Promise.all([
    source.own
      ? ownEventValues(db, orgId, mode, templateId, source.own, now - 2 * DAY)
      : { values: [], more: false, unparsed: 0 },
    source.list
      ? listedEventValues(db, orgId, mode, templateId, source.list, now - 2 * DAY)
      : { values: [], more: false, unparsed: 0 },
  ]);
  if (own.unparsed + listed.unparsed > 0)
    ctx.log.warn('scan.template_setup.start_skipped', {
      orgId,
      code: 'START_NOT_ISO',
      count: own.unparsed + listed.unparsed,
    });
  const plan = planEvents(templateId, source, [...own.values, ...listed.values], now);
  const planned = plan.events;
  const truncated = plan.more || own.more || listed.more;
  const eventStyle = source.own !== null || source.list !== null;
  const timeZone =
    input.timeZone ??
    planned.find((e) => e.timeZone)?.timeZone ??
    (await readOrgTimeZone(db, orgId));
  const actor = await setupActor(ctx, auth, authority, mode);
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
      match: e.match ? { input: e.match.input, values: [e.match.value] } : null,
    });
    if (!body.success) {
      ctx.log.warn('scan.template_setup.event_skipped', { orgId, code: 'EVENT_INVALID' });
      return null;
    }
    try {
      const made = await actor.createEvent(body.data, e.key);
      return { id: made.id, name: made.name, created: true };
    } catch (error) {
      // A concurrent call may hold the key: take its event. Anything else is the caller's error.
      const winner = await setupEvent(db, orgId, mode, e.key);
      if (!winner) throw error;
      return { id: winner.id, name: e.name, created: false };
    }
  };
  /** Archive what this call made and no session or scanner uses, so no stray event is left and no one else's is dropped. */
  const discard = async (events: readonly Made[]) => {
    for (const e of events.filter((made) => made.created)) {
      try {
        await actor.archiveEvent(e.id, { unattached: true });
      } catch (cleanup) {
        // Another call attached it: it is that call's event now.
        if (cleanup instanceof AppError && cleanup.code === 'EVENT_IN_USE') continue;
        ctx.log.error('scan.template_setup.cleanup_failed', {
          orgId,
          code: 'SETUP_CLEANUP_FAILED',
          error: cleanup,
        });
      }
    }
  };
  const findSession = async () =>
    (await setupSession(db, orgId, mode, templateId)) ??
    (await sessionScanningTemplate(db, orgId, mode, templateId));

  const addToExisting = async (
    sessionId: string,
    made: Made[] = [],
  ): Promise<TemplateScanSetup> => {
    let row = await loadScanningSession(ctx, sessionId, mode, orgId);
    const unchanged = async (): Promise<TemplateScanSetup> => {
      await discard(made);
      return {
        session: { id: row.id, name: row.name },
        created: false,
        events: [],
        noEvents: false,
        truncated,
      };
    };
    // A session that admits every pass type, or one whose scope no longer reads, is left as it is.
    if (!storedAdmits(row.accepts)) return unchanged();
    const room = MAX_EVENTS - (storedAdmits(row.accepts)?.eventIds.length ?? 0);
    for (const e of planned) {
      if (made.length >= room) break;
      const known = await setupEvent(db, orgId, mode, e.key);
      if (known && storedAdmits(row.accepts)?.eventIds.includes(known.id)) continue;
      const event = await ensureEvent(e);
      if (event) made.push(event);
    }
    // Merge into what the session admits now; a concurrent edit costs one retry.
    for (let attempt = 0; ; attempt++) {
      const admits = storedAdmits(row.accepts);
      if (!admits) return unchanged();
      const have = new Set(admits.eventIds);
      const attach = made.filter((e) => !have.has(e.id)).slice(0, MAX_EVENTS - have.size);
      // The setup session keeps the template: an edit that dropped it is undone.
      const templateIds =
        row.setup_template_id === templateId && !admits.templateIds.includes(templateId)
          ? [...admits.templateIds, templateId]
          : admits.templateIds;
      // Events this call made beyond the session's room stay unattached: archive them.
      const over = () => made.filter((e) => !have.has(e.id) && !attach.includes(e));
      if (attach.length === 0 && templateIds === admits.templateIds) {
        await discard(over());
        return {
          session: { id: row.id, name: row.name },
          created: false,
          events: [],
          noEvents: eventStyle && have.size === 0,
          truncated,
        };
      }
      try {
        await actor.updateSession(sessionId, {
          templateIds,
          eventIds: [...have, ...attach.map((e) => e.id)],
        });
        await discard(over());
        return {
          session: { id: row.id, name: row.name },
          created: false,
          events: attach,
          noEvents: eventStyle && have.size + attach.length === 0,
          truncated,
        };
      } catch (error) {
        if (
          attempt === 0 &&
          error instanceof AppError &&
          error.code === 'SCANNING_SESSION_CHANGED'
        ) {
          row = await loadScanningSession(ctx, sessionId, mode, orgId);
          continue;
        }
        await discard(made);
        throw error;
      }
    }
  };

  const existing = await findSession();
  if (existing) return addToExisting(existing.id);

  // No session yet: its events, the session and the one-time keys commit in one batch.
  const intent = ScanSetupIntentSchema.parse({
    orgId,
    timeZone,
    events: [{ fromTemplate: templateId, ref: 'template' }],
    doors: [
      {
        name: plainText(template.manifest.name, 80) ?? 'Scanning',
        admits: { templateIds: [templateId], events: ['template'] },
        ...(checkInOf(template.manifest)
          ? { more: { checkIn: checkInOf(template.manifest) } }
          : {}),
      },
    ],
  });
  const actorId = auth.kind === 'api_key' ? auth.keyId : auth.userId;
  for (let attempt = 0; ; attempt++) {
    try {
      const { plan, facts } = await planSetupIntent(ctx, authority, intent);
      const made = await applySetupPlan(ctx, actorId, authority, plan, facts, {
        origin: '',
        setupTemplateId: templateId,
      });
      return {
        session: { id: made.sessions[0]?.id ?? '', name: made.sessions[0]?.name ?? '' },
        created: true,
        events: made.events.map(({ id, name, created }) => ({ id, name, created })),
        noEvents: eventStyle && made.events.length === 0,
        truncated,
      };
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'SCAN_SETUP_NAME_TAKEN') throw error;
      // A concurrent call holds the session or an event key: take its session, else try once more.
      const winner = await findSession();
      if (winner) {
        ctx.log.info('scan.template_setup.raced', { orgId, code: 'SETUP_RACED' });
        return addToExisting(winner.id);
      }
      if (attempt > 0)
        throw new ConflictError(
          'Another session already scans this template. Reload and try again.',
          'SCAN_SETUP_CONFLICT',
        );
    }
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
