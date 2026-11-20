import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import type {
  CreateScanEventSchema,
  ScanEventAssignSchema,
  UpdateScanEventSchema,
} from '../../../shared/contracts/index.ts';
import { maxNow } from '../../platform/authority-expr.ts';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { admitsJson } from './admits.ts';
import {
  checkTemplates,
  checkWindow,
  commitEvent,
  committedEventView,
  loadManageEvent,
} from './events.ts';
import { assertStandaloneSession } from './legacy-session.ts';
import {
  adminActorOf,
  adminGrant,
  audited,
  createdByOf,
  eventEpoch,
  scannersAssignable,
  templatesUsable,
} from './repo-admin-grant.ts';
import { attachedTemplateChecks, eventReleaseChecks } from './repo-event-authority.ts';
import type { EventAuthority } from './repo-event-keyset.ts';
import {
  addEventArchive,
  addEventAssign,
  addEventInsert,
  addEventRestore,
  addEventTemplates,
  addEventUpdate,
  type EventValues,
  eventArchiveChecks,
  eventDependents,
  scannersInOrg,
} from './repo-events-write.ts';
import { addScannerPatchSessionSync } from './repo-scanner-configuration-sync.ts';

const EVENT_CODES = {
  config: 'SCAN_EVENT_CHANGED',
  lineage: 'SCAN_EVENT_CHANGED',
  release: 'SCAN_EVENT_CHANGED',
} as const;

const modeMismatch = (what: string) =>
  new ValidationError(`${what} is in a different mode.`, [], 'SCAN_MODE_MISMATCH');

export async function createEvent(
  ctx: ServiceContext,
  userId: string,
  mode: Mode,
  input: z.infer<typeof CreateScanEventSchema>,
  authority: TenantPassWrite,
  /** Scan passes: one live event per key. A second insert fails on the unique index. */
  setupKey?: string,
) {
  if (authority.orgId !== input.orgId || authority.mode !== mode) throw new ForbiddenError();
  if (input.hardLimit && input.capacity == null)
    throw new ValidationError('Set a capacity first.', [], 'EVENT_NEEDS_CAPACITY');
  const templateIds = [...new Set(input.templateIds)];
  const stamps = await checkTemplates(
    ctx,
    input.orgId,
    mode,
    templateIds,
    input.match?.input ?? null,
  );
  const values: EventValues = {
    id: ctx.ids.id(),
    orgId: input.orgId,
    mode,
    name: input.name,
    matchInput: input.match?.input ?? null,
    matchValues: input.match?.values ?? null,
    opensAt: input.opensAt,
    closesAt: input.closesAt,
    timeZone: input.timeZone,
    capacity: input.capacity ?? null,
    reentry: input.reentry ?? false,
    hardLimit: input.hardLimit ?? false,
    note: input.note ?? null,
    ...(setupKey ? { setupKey } : {}),
  };
  const now = ctx.clock.now();
  const g = adminGrant(
    ctx,
    'org_mode.scan.event.create',
    userId,
    authority,
    input.orgId,
    [...templatesUsable(templateIds), ...eventReleaseChecks(stamps, mode)],
    EVENT_CODES,
    values.id,
  );
  addEventInsert(g, values, createdByOf(authority, userId), now);
  addEventTemplates(g, values.id, templateIds, false);
  g.add(
    audited(g, ctx, {
      orgId: input.orgId,
      ...adminActorOf(authority, userId),
      action: 'scan_event.create',
      targetType: 'scan_event',
      targetId: values.id,
      detail: { mode, templates: templateIds.length, capacity: values.capacity },
    }),
  );
  const committed = await commitEvent(ctx, g, values.id, input.orgId);
  return committedEventView(ctx, committed);
}

export async function updateEvent(
  ctx: ServiceContext,
  userId: string,
  id: string,
  input: z.infer<typeof UpdateScanEventSchema>,
  authority: EventAuthority,
) {
  const row = await loadManageEvent(ctx, id, userId, authority);
  const match =
    input.match === undefined
      ? row.matchInput && row.matchValues
        ? { input: row.matchInput, values: row.matchValues }
        : null
      : input.match;
  const templateIds = input.templateIds ? [...new Set(input.templateIds)] : row.templateIds;
  const opensAt = input.opensAt ?? row.opensAt;
  const closesAt = input.closesAt ?? row.closesAt;
  checkWindow(opensAt, closesAt);
  const capacity = input.capacity === undefined ? row.capacity : input.capacity;
  const hardLimit = input.hardLimit ?? (capacity === null ? false : row.hardLimit);
  if (hardLimit && capacity === null)
    throw new ValidationError('Set a capacity first.', [], 'EVENT_NEEDS_CAPACITY');
  if (
    !input.templateIds &&
    input.match !== undefined &&
    row.storedTemplateIds.length !== row.templateIds.length
  )
    throw new ConflictError(
      'The event templates changed. Reload and try again.',
      'SCAN_EVENT_CHANGED',
    );
  const checking = !!input.templateIds || input.match !== undefined;
  // Templates already on the event may be archived (they keep scanning); new ones must be active.
  const added = checking ? templateIds.filter((t) => !row.storedTemplateIds.includes(t)) : [];
  const kept = checking ? templateIds.filter((t) => row.storedTemplateIds.includes(t)) : [];
  const stamps = checking
    ? await checkTemplates(ctx, row.orgId, row.mode, templateIds, match?.input ?? null, added)
    : undefined;
  const { archived, ...fields } = input;
  const archive = archived === true && row.archivedAt === null;
  const restore = archived === false && row.archivedAt !== null;
  const dependents = archive
    ? await eventDependents(ctx.env.DB, row.orgId, row.mode, id)
    : undefined;
  const now = ctx.clock.now();
  const g = adminGrant(
    ctx,
    'org_mode.scan.event.update',
    userId,
    authority,
    row.orgId,
    [
      eventEpoch(id, row.configEpoch),
      ...attachedTemplateChecks(added, kept, stamps, row.mode),
      ...(dependents ? eventArchiveChecks(id, dependents) : []),
    ],
    EVENT_CODES,
    id,
  );
  addEventUpdate(
    g,
    id,
    {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.match === undefined ? {} : { match: input.match }),
      ...(input.opensAt === undefined ? {} : { opensAt: input.opensAt }),
      ...(input.closesAt === undefined ? {} : { closesAt: input.closesAt }),
      ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
      ...(input.capacity === undefined ? {} : { capacity: input.capacity }),
      ...(input.reentry === undefined ? {} : { reentry: input.reentry }),
      ...(hardLimit === row.hardLimit ? {} : { hardLimit }),
      ...(input.note === undefined ? {} : { note: input.note }),
    },
    now,
  );
  if (input.templateIds) addEventTemplates(g, id, templateIds, true);
  if (dependents) addEventArchive(g, id, dependents, now);
  if (restore) addEventRestore(g, id, now);
  g.add(
    audited(g, ctx, {
      orgId: row.orgId,
      actorType: 'user',
      actorId: userId,
      action: archive ? 'scan_event.archive' : 'scan_event.update',
      targetType: 'scan_event',
      targetId: id,
      detail: { fields: Object.keys(fields), ...(restore ? { restored: true } : {}) },
    }),
  );
  const committed = await commitEvent(ctx, g, id, row.orgId);
  return committedEventView(ctx, committed);
}

export async function archiveEvent(
  ctx: ServiceContext,
  userId: string,
  id: string,
  authority: TenantPassWrite,
) {
  const row = await loadManageEvent(ctx, id, userId, authority);
  const archive = row.archivedAt === null;
  const dependents = archive
    ? await eventDependents(ctx.env.DB, row.orgId, row.mode, id)
    : undefined;
  const now = ctx.clock.now();
  const g = adminGrant(
    ctx,
    'org_mode.scan.event.archive',
    userId,
    authority,
    row.orgId,
    [eventEpoch(id, row.configEpoch), ...(dependents ? eventArchiveChecks(id, dependents) : [])],
    EVENT_CODES,
    id,
  );
  if (dependents) {
    addEventArchive(g, id, dependents, now);
    g.add(
      audited(g, ctx, {
        orgId: row.orgId,
        ...adminActorOf(authority, userId),
        action: 'scan_event.archive',
        targetType: 'scan_event',
        targetId: id,
        detail: { detached: row.scanners },
      }),
    );
  } else {
    // Already archived: nothing to write, but the caller still answers to a live manager.
    g.update('scan_events', { set: { updated_at: maxNow(now) }, where: { id }, require: 'one' });
  }
  const committed = await commitEvent(ctx, g, id, row.orgId);
  return committedEventView(ctx, committed);
}

/** Moves scanners onto the event. Another org's scanner is a 404, another mode's a 422. */
export async function assignScanners(
  ctx: ServiceContext,
  userId: string,
  id: string,
  input: z.infer<typeof ScanEventAssignSchema>,
  authority: EventAuthority,
) {
  const db = ctx.env.DB;
  const row = await loadManageEvent(ctx, id, userId, authority);
  if (row.archivedAt !== null)
    throw new ValidationError('This event is archived.', [], 'EVENT_ARCHIVED');
  const ids = [...new Set(input.scannerIds)];
  const found = await scannersInOrg(db, row.orgId, ids);
  if (found.length !== ids.length)
    throw new NotFoundError('Scanner not found.', 'SCANNER_NOT_FOUND');
  if (found.some((s) => s.mode !== row.mode)) throw modeMismatch('A scanner');
  if (found.some((s) => s.deviceRole !== 'scan'))
    throw new ValidationError('Only scanning devices take an event.', [], 'SCANNER_CANNOT_SCAN');
  await Promise.all(ids.map((scannerId) => assertStandaloneSession(ctx, row.orgId, scannerId)));
  const stamps =
    ids.length > 0
      ? await checkTemplates(ctx, row.orgId, row.mode, row.storedTemplateIds, row.matchInput, [])
      : undefined;
  const kept = ids.length > 0 ? row.storedTemplateIds : [];
  const now = ctx.clock.now();
  const g = adminGrant(
    ctx,
    'org_mode.scan.event.assign',
    userId,
    authority,
    row.orgId,
    [
      eventEpoch(id, row.configEpoch),
      ...attachedTemplateChecks([], kept, stamps, row.mode),
      ...scannersAssignable(ids),
    ],
    EVENT_CODES,
    id,
  );
  if (ids.length > 0) {
    addEventAssign(g, id, ids, now);
    for (const scannerId of ids)
      addScannerPatchSessionSync(
        g,
        scannerId,
        { accepts: admitsJson({ templateIds: [], eventIds: [id] }) },
        now,
      );
    g.add(
      audited(g, ctx, {
        orgId: row.orgId,
        actorType: 'user',
        actorId: userId,
        action: 'scan_event.assign',
        targetType: 'scan_event',
        targetId: id,
        detail: { scanners: ids.length },
      }),
    );
  } else {
    // Nothing to move, but the caller still answers to a live manager of this event.
    g.update('scan_events', { set: { updated_at: maxNow(now) }, where: { id }, require: 'one' });
  }
  const committed = await commitEvent(ctx, g, id, row.orgId);
  return committedEventView(ctx, committed);
}
