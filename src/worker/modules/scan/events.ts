import type { z } from 'zod';
import type { TemplateManifest } from '../../../passkit/types.ts';
import type { Json, Mode } from '../../../shared/contracts/common.ts';
import type {
  CreateScanEventSchema,
  ScanEventAssignSchema,
  ScanEventDto,
  ScanEventListQuerySchema,
  UpdateScanEventSchema,
} from '../../../shared/contracts/index.ts';
import { scanOf } from '../../../shared/scan-defaults.ts';
import { batch } from '../../platform/db.ts';
import { NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';
import { orgIsActive } from '../orgs/repo.ts';
import {
  archiveEventStmts,
  assignScannersStmts,
  type ConsoleEventRow,
  countExpected,
  type EventValues,
  getConsoleEvent,
  insertEventStmt,
  listConsoleEvents,
  replaceEventTemplatesStmts,
  restoreEventStmt,
  scannersInOrg,
  setExpectedStmt,
  templateManifests,
  updateEventStmt,
} from './repo-events.ts';
import { countOrgTemplates } from './repo-scope.ts';

const EXPECTED_TTL_MS = 60_000;
/** A list recounts at most this many stale events; the rest show their last count. */
const LIST_RECOUNTS = 10;
const SCALAR = new Set(['string', 'number', 'integer', 'boolean']);

const modeMismatch = (what: string) =>
  new ValidationError(`${what} is in a different mode.`, [], 'SCAN_MODE_MISMATCH');

export function eventStatus(row: ConsoleEventRow, now: number): ScanEventDto['status'] {
  if (row.archivedAt !== null) return 'archived';
  if (now < row.opensAt) return 'upcoming';
  return now > row.closesAt ? 'ended' : 'live';
}

function toDto(row: ConsoleEventRow, now: number): ScanEventDto {
  return {
    id: row.id,
    orgId: row.orgId,
    mode: row.mode,
    name: row.name,
    templateIds: row.templateIds,
    match:
      row.matchInput && row.matchValues ? { input: row.matchInput, values: row.matchValues } : null,
    opensAt: row.opensAt,
    closesAt: row.closesAt,
    timeZone: row.timeZone,
    capacity: row.capacity,
    reentry: row.reentry,
    note: row.note,
    status: eventStatus(row, now),
    arrived: row.arrived,
    expected: row.expected ?? 0,
    scanners: row.scanners,
  };
}

/** Recounts `expected` when it is older than a minute (or was cleared by an edit). */
async function refreshed(ctx: ServiceContext, row: ConsoleEventRow): Promise<ConsoleEventRow> {
  const now = ctx.clock.now();
  if (row.expectedAt !== null && row.expectedAt > now - EXPECTED_TTL_MS) return row;
  const n = await countExpected(ctx.env.DB, row);
  await setExpectedStmt(ctx.env.DB, row.id, n, now).run();
  return { ...row, expected: n, expectedAt: now };
}

export async function listEvents(
  ctx: ServiceContext,
  mode: Mode,
  query: z.infer<typeof ScanEventListQuerySchema>,
) {
  const now = ctx.clock.now();
  const rows = await listConsoleEvents(ctx.env.DB, { ...query, mode, now, limit: query.limit + 1 });
  const page = rows.slice(0, query.limit);
  let budget = LIST_RECOUNTS;
  const items: ScanEventDto[] = [];
  for (const row of page) {
    const stale = row.expectedAt === null || row.expectedAt <= now - EXPECTED_TTL_MS;
    items.push(toDto(stale && budget-- > 0 ? await refreshed(ctx, row) : row, now));
  }
  return { items, nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null };
}

async function loadEvent(ctx: ServiceContext, id: string): Promise<ConsoleEventRow> {
  const row = await getConsoleEvent(ctx.env.DB, id);
  if (!row) throw new NotFoundError('Event not found.', 'EVENT_NOT_FOUND');
  return row;
}

export async function eventView(ctx: ServiceContext, id: string): Promise<ScanEventDto> {
  return toDto(await refreshed(ctx, await loadEvent(ctx, id)), ctx.clock.now());
}

/** Every template needs a check-in, and a match input must be a scalar input of each. */
async function checkTemplates(
  ctx: ServiceContext,
  orgId: string,
  templateIds: string[],
  matchInput: string | null,
): Promise<void> {
  const db = ctx.env.DB;
  if ((await countOrgTemplates(db, orgId, templateIds)) !== templateIds.length)
    throw new NotFoundError('Template not found.', 'TEMPLATE_NOT_FOUND');
  for (const t of await templateManifests(db, orgId, templateIds)) {
    const manifest = JSON.parse(t.manifest) as TemplateManifest;
    if (!scanOf(manifest).actions.some((a) => a.kind === 'check_in'))
      throw new ValidationError(
        `${manifest.name} has no check-in action.`,
        [{ path: 'templateIds', message: 'Choose templates that check people in.' }],
        'EVENT_TEMPLATE_NO_CHECK_IN',
      );
    if (matchInput) {
      const prop = (manifest.inputs.properties?.[matchInput] ?? null) as { type?: Json } | null;
      if (
        !prop ||
        typeof prop.type !== 'string' ||
        !SCALAR.has(prop.type) ||
        /["\\]/.test(matchInput)
      )
        throw new ValidationError(
          `${manifest.name} has no single-value input called ${matchInput}.`,
          [{ path: 'match.input', message: 'Match on an input that holds one value.' }],
          'EVENT_MATCH_INPUT',
        );
    }
  }
}

function checkWindow(opensAt: number, closesAt: number): void {
  if (closesAt <= opensAt)
    throw new ValidationError('Closing must be after opening.', [
      { path: 'closesAt', message: 'Closing must be after opening.' },
    ]);
}

export async function createEvent(
  ctx: ServiceContext,
  userId: string,
  mode: Mode,
  input: z.infer<typeof CreateScanEventSchema>,
) {
  const db = ctx.env.DB;
  if (!(await orgIsActive(db, input.orgId)))
    throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  const templateIds = [...new Set(input.templateIds)];
  await checkTemplates(ctx, input.orgId, templateIds, input.match?.input ?? null);
  const now = ctx.clock.now();
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
    note: input.note ?? null,
  };
  await batch(db, [
    insertEventStmt(db, values, userId, now),
    ...replaceEventTemplatesStmts(db, values.id, templateIds),
    auditStmt(db, ctx, {
      orgId: input.orgId,
      actorType: 'user',
      actorId: userId,
      action: 'scan_event.create',
      targetType: 'scan_event',
      targetId: values.id,
      detail: { mode, templates: templateIds.length, capacity: values.capacity },
    }),
  ]);
  return eventView(ctx, values.id);
}

export async function updateEvent(
  ctx: ServiceContext,
  userId: string,
  id: string,
  input: z.infer<typeof UpdateScanEventSchema>,
) {
  const db = ctx.env.DB;
  const row = await loadEvent(ctx, id);
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
  if (input.templateIds || input.match !== undefined)
    await checkTemplates(ctx, row.orgId, templateIds, match?.input ?? null);
  const now = ctx.clock.now();
  const values: EventValues = {
    id,
    orgId: row.orgId,
    mode: row.mode,
    name: input.name ?? row.name,
    matchInput: match?.input ?? null,
    matchValues: match?.values ?? null,
    opensAt,
    closesAt,
    timeZone: input.timeZone ?? row.timeZone,
    capacity: input.capacity === undefined ? row.capacity : input.capacity,
    reentry: input.reentry ?? row.reentry,
    note: input.note === undefined ? row.note : input.note,
  };
  const { archived, ...fields } = input;
  const archive = archived === true && row.archivedAt === null;
  const restore = archived === false && row.archivedAt !== null;
  await batch(db, [
    updateEventStmt(db, values, now),
    ...(input.templateIds ? replaceEventTemplatesStmts(db, id, templateIds) : []),
    ...(archive ? archiveEventStmts(db, id, now) : []),
    ...(restore ? [restoreEventStmt(db, id, now)] : []),
    auditStmt(db, ctx, {
      orgId: row.orgId,
      actorType: 'user',
      actorId: userId,
      action: archive ? 'scan_event.archive' : 'scan_event.update',
      targetType: 'scan_event',
      targetId: id,
      detail: { fields: Object.keys(fields), ...(restore ? { restored: true } : {}) },
    }),
  ]);
  return eventView(ctx, id);
}

export async function archiveEvent(ctx: ServiceContext, userId: string, id: string) {
  const row = await loadEvent(ctx, id);
  if (row.archivedAt === null) {
    const db = ctx.env.DB;
    await batch(db, [
      ...archiveEventStmts(db, id, ctx.clock.now()),
      auditStmt(db, ctx, {
        orgId: row.orgId,
        actorType: 'user',
        actorId: userId,
        action: 'scan_event.archive',
        targetType: 'scan_event',
        targetId: id,
        detail: { detached: row.scanners },
      }),
    ]);
  }
  return eventView(ctx, id);
}

/** Moves scanners onto the event. Another org's scanner is a 404, another mode's a 422. */
export async function assignScanners(
  ctx: ServiceContext,
  userId: string,
  id: string,
  input: z.infer<typeof ScanEventAssignSchema>,
) {
  const db = ctx.env.DB;
  const row = await loadEvent(ctx, id);
  if (row.archivedAt !== null)
    throw new ValidationError('This event is archived.', [], 'EVENT_ARCHIVED');
  const ids = [...new Set(input.scannerIds)];
  const found = await scannersInOrg(db, row.orgId, ids);
  if (found.length !== ids.length)
    throw new NotFoundError('Scanner not found.', 'SCANNER_NOT_FOUND');
  if (found.some((s) => s.mode !== row.mode)) throw modeMismatch('A scanner');
  if (found.some((s) => s.deviceRole !== 'scan'))
    throw new ValidationError('Only scanning devices take an event.', [], 'SCANNER_CANNOT_SCAN');
  if (ids.length > 0)
    await batch(db, [
      ...assignScannersStmts(db, id, row.orgId, ids, ctx.clock.now()),
      auditStmt(db, ctx, {
        orgId: row.orgId,
        actorType: 'user',
        actorId: userId,
        action: 'scan_event.assign',
        targetType: 'scan_event',
        targetId: id,
        detail: { scanners: ids.length },
      }),
    ]);
  return eventView(ctx, id);
}
