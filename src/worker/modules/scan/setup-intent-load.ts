import type { AccessManifest, TemplateManifest } from '../../../passkit/types.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { CreateScanEventSchema } from '../../../shared/contracts/index.ts';
import type { ScanSetupIntent } from '../../../shared/contracts/scan-setup-intent.ts';
import type {
  EventFacts,
  SetupPlanContext,
  TemplateFacts,
} from '../../../shared/scan-setup-plan-types.ts';
import { DEFAULT_TIME_ZONE } from '../../../shared/time-zone.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { orgIsActive } from '../orgs/repo.ts';
import { syncBakedTemplates } from '../templates/sync.ts';
import { readOrgTimeZone } from './repo-org-clock.ts';
import {
  activeStaff,
  eventTemplateLinks,
  issuedCounts,
  liveEvents,
  takenScannerNames,
  takenStaffNames,
  takenZoneNames,
  visibleTemplates,
} from './repo-setup-intent.ts';
import { listedEventValues, ownEventValues, setupEvent } from './repo-template-setup.ts';
import { orgZoneRows } from './repo-zones.ts';
import type { TakenNames } from './setup-names.ts';
import { eventSource, planEvents } from './template-setup-plan.ts';

const DAY = 86_400_000;

/** What the plan reads, and the names the batch must not take. Everything is of the caller's org and mode. */
export interface SetupFacts {
  plan: SetupPlanContext;
  taken: { zones: TakenNames; staff: TakenNames; scanners: TakenNames };
  /** A planned fromTemplate event's Scan passes key (one live event per key) and venue note, by its ref. */
  eventKeys: Map<string, { key: string; note: string | null }>;
}

const planFacts = (manifest: TemplateManifest): TemplateFacts['plans'] => {
  const access = manifest.scan?.access as AccessManifest | undefined;
  return access
    ? access.plans.map((p) => ({
        id: p.id,
        label: p.label,
        zones: p.zones.flatMap((g) => (typeof g.zone === 'string' ? [g.zone] : [])),
        hours: p.hours ?? null,
      }))
    : null;
};

const idsOf = (intent: ScanSetupIntent) => {
  const templates = new Set<string>();
  const events = new Set<string>();
  for (const e of intent.events) {
    if ('eventId' in e) events.add(e.eventId);
    else if ('fromTemplate' in e) templates.add(e.fromTemplate);
    else for (const id of e.templateIds) templates.add(id);
  }
  for (const d of intent.doors) {
    if ('templateIds' in d.admits) {
      for (const id of d.admits.templateIds) templates.add(id);
      for (const id of d.admits.events) events.add(id);
    }
  }
  return { templates: [...templates], events };
};

/** The upcoming events a template's issued passes name, each with the live event that already is it. */
async function upcomingOf(
  ctx: ServiceContext,
  orgId: string,
  mode: Mode,
  templateId: string,
  manifest: TemplateManifest,
  keys: Map<string, { key: string; note: string | null }[]>,
): Promise<NonNullable<TemplateFacts['upcomingEvents']>> {
  const db = ctx.env.DB;
  const source = eventSource(manifest);
  const since = ctx.clock.now() - 2 * DAY;
  const empty = { values: [], more: false, unparsed: 0 };
  const [own, listed] = await Promise.all([
    source.own ? ownEventValues(db, orgId, mode, templateId, source.own, since) : empty,
    source.list ? listedEventValues(db, orgId, mode, templateId, source.list, since) : empty,
  ]);
  if (own.unparsed + listed.unparsed > 0)
    ctx.log.warn('scan.template_setup.start_skipped', {
      orgId,
      code: 'START_NOT_ISO',
      count: own.unparsed + listed.unparsed,
    });
  const planned = planEvents(
    templateId,
    source,
    [...own.values, ...listed.values],
    ctx.clock.now(),
  ).events;
  const out: NonNullable<TemplateFacts['upcomingEvents']> = [];
  const extras: { key: string; note: string | null }[] = [];
  for (const e of planned) {
    // An event its create schema would refuse is skipped, as Scan passes always did.
    if (
      !CreateScanEventSchema.safeParse({
        orgId,
        name: e.name,
        templateIds: [templateId],
        opensAt: e.opensAt,
        closesAt: e.closesAt,
        timeZone: e.timeZone ?? DEFAULT_TIME_ZONE,
        note: e.venue,
        match: e.match ? { input: e.match.input, values: [e.match.value] } : null,
      }).success
    ) {
      ctx.log.warn('scan.template_setup.event_skipped', { orgId, code: 'EVENT_INVALID' });
      continue;
    }
    extras.push({ key: e.key, note: e.venue });
    out.push({
      name: e.name,
      opensAt: e.opensAt,
      closesAt: e.closesAt,
      timeZone: e.timeZone,
      match: e.match,
      existingId: (await setupEvent(db, orgId, mode, e.key))?.id ?? null,
    });
  }
  keys.set(templateId, extras);
  return out;
}

async function loadTemplates(
  ctx: ServiceContext,
  orgId: string,
  mode: Mode,
  ids: string[],
  fromTemplate: Set<string>,
  keys: Map<string, { key: string; note: string | null }[]>,
): Promise<TemplateFacts[]> {
  if (ids.length === 0) return [];
  const db = ctx.env.DB;
  if (ids.some((id) => id.startsWith('baked:'))) await syncBakedTemplates(ctx);
  const [rows, issued] = await Promise.all([
    visibleTemplates(db, orgId, ids),
    issuedCounts(db, orgId, ids),
  ]);
  const out: TemplateFacts[] = [];
  for (const r of rows) {
    const manifest = JSON.parse(r.manifest) as TemplateManifest;
    const count = (m: Mode) => issued.find((i) => i.template_id === r.id && i.mode === m)?.n ?? 0;
    out.push({
      id: r.id,
      name: r.name,
      plans: planFacts(manifest),
      issued: { live: count('live'), test: count('test') },
      ...(fromTemplate.has(r.id)
        ? { upcomingEvents: await upcomingOf(ctx, orgId, mode, r.id, manifest, keys) }
        : {}),
    });
  }
  return out;
}

async function loadEvents(
  ctx: ServiceContext,
  orgId: string,
  mode: Mode,
  ids: string[],
): Promise<EventFacts[]> {
  if (ids.length === 0) return [];
  const db = ctx.env.DB;
  const [rows, links] = await Promise.all([
    liveEvents(db, orgId, mode, ids),
    eventTemplateLinks(db, ids),
  ]);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    reentry: r.reentry === 1,
    capacity: r.capacity,
    templateIds: links.filter((l) => l.event_id === r.id).map((l) => l.template_id),
  }));
}

/** Every read the plan and the name picking need, in the caller's org and mode. Nothing is written. */
export async function loadSetupFacts(
  ctx: ServiceContext,
  orgId: string,
  mode: Mode,
  intent: ScanSetupIntent,
): Promise<SetupFacts> {
  const db = ctx.env.DB;
  if (!(await orgIsActive(db, orgId)))
    throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  const wanted = idsOf(intent);
  const fromTemplate = new Set(
    intent.events.flatMap((e) => ('fromTemplate' in e ? [e.fromTemplate] : [])),
  );
  const extras = new Map<string, { key: string; note: string | null }[]>();
  const [orgTimeZone, templates, zones, staff, taken] = await Promise.all([
    readOrgTimeZone(db, orgId),
    loadTemplates(ctx, orgId, mode, wanted.templates, fromTemplate, extras),
    orgZoneRows(db, orgId),
    activeStaff(db, orgId),
    Promise.all([
      takenZoneNames(db, orgId),
      takenStaffNames(db, orgId),
      takenScannerNames(db, orgId, mode),
    ]),
  ]);
  const eventKeys: SetupFacts['eventKeys'] = new Map();
  intent.events.forEach((e, i) => {
    if (!('fromTemplate' in e)) return;
    (extras.get(e.fromTemplate) ?? []).forEach((x, n) => {
      eventKeys.set(`${e.ref ?? `template-${i + 1}`}-${n + 1}`, x);
    });
  });
  for (const t of templates)
    for (const u of t.upcomingEvents ?? []) if (u.existingId) wanted.events.add(u.existingId);
  return {
    plan: {
      mode,
      orgTimeZone,
      templates,
      zones: zones.map((z) => ({
        id: z.id,
        key: z.key,
        name: z.name,
        parentId: z.parentId,
        archived: z.archivedAt !== null,
        occupancy: z.occupancy,
        capacity: z.capacity,
      })),
      events: await loadEvents(ctx, orgId, mode, [...wanted.events]),
      staff: staff.map((s) => ({ id: s.id, role: s.role, active: true })),
    },
    taken: { zones: taken[0], staff: taken[1], scanners: taken[2] },
    eventKeys,
  };
}
