import type { z } from 'zod';
import type {
  CreateScanZoneSchema,
  ScanZone,
  ScanZoneListQuerySchema,
  UpdateScanZoneSchema,
} from '../../../shared/contracts/scan-access.ts';
import { classifyD1Error } from '../../platform/db.ts';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { orgIsActive } from '../orgs/repo.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { accessTemplates } from './repo-access.ts';
import { adminGrant, audited } from './repo-admin-grant.ts';
import {
  addZoneArchive,
  addZoneInsert,
  addZoneUpdate,
  orgZoneRows,
  type ZoneRow,
  zoneFitsUnder,
  zoneSubtreeIs,
  zonesOpen,
} from './repo-zones.ts';
import { plansByZone } from './zones-plans.ts';
import {
  assertPlacement,
  depthOf,
  effectiveTimeZone,
  indexZones,
  subtree,
  treeOrder,
} from './zones-tree.ts';

type Authority = Extract<TenantPassWrite, { kind: 'session' }>;
type Query = z.infer<typeof ScanZoneListQuerySchema>;
type Create = z.infer<typeof CreateScanZoneSchema>;
type Update = z.infer<typeof UpdateScanZoneSchema>;

const ZONE_CODES = { config: 'SCAN_ZONE_CHANGED', lineage: 'SCAN_ZONE_CHANGED' } as const;
const notFound = () => new NotFoundError('Zone not found.', 'ZONE_NOT_FOUND');
const invalid = (message: string, code: string) => new ValidationError(message, [], code);

function assertAuthority(
  authority: Authority,
  orgId: string,
  capability: 'scanning:read' | 'scanning:manage',
): void {
  if (
    authority.kind !== 'session' ||
    authority.orgId !== orgId ||
    authority.capability !== capability
  )
    throw new ForbiddenError();
}

function toDto(row: ZoneRow, rows: readonly ZoneRow[], plans: ScanZone['plans']): ScanZone {
  const index = indexZones(rows);
  return {
    id: row.id,
    orgId: row.orgId,
    key: row.key,
    name: row.name,
    parentId: row.parentId,
    timeZone: row.timeZone,
    effectiveTimeZone: effectiveTimeZone(index, row.id),
    sort: row.sort,
    depth: depthOf(index, row.id),
    occupancy: row.occupancy,
    capacity: row.capacity,
    maxStayMinutes: row.maxStayMinutes,
    clearAt: row.clearAt,
    sessions: row.sessions,
    plans,
    // The count of who is inside comes from the occupancy package.
    inNow: null,
    archivedAt: row.archivedAt,
  };
}

export async function listZones(ctx: ServiceContext, authority: Authority, query: Query) {
  assertAuthority(authority, query.orgId, 'scanning:read');
  const [rows, templates] = await Promise.all([
    orgZoneRows(ctx.env.DB, query.orgId),
    accessTemplates(ctx.env.DB, query.orgId),
  ]);
  const plans = plansByZone(rows, templates);
  const shown = treeOrder(
    rows.filter((r) => (query.archived === 'true' ? r.archivedAt !== null : r.archivedAt === null)),
  );
  const start = query.cursor ? shown.findIndex((r) => r.id === query.cursor) + 1 : 0;
  const page = shown.slice(start, start + query.limit);
  return {
    items: page.map((r) => toDto(r, rows, plans.get(r.id) ?? [])),
    nextCursor: start + query.limit < shown.length ? (page.at(-1)?.id ?? null) : null,
  };
}

async function committed(ctx: ServiceContext, orgId: string, id: string): Promise<ScanZone> {
  const [rows, templates] = await Promise.all([
    orgZoneRows(ctx.env.DB, orgId),
    accessTemplates(ctx.env.DB, orgId),
  ]);
  const row = rows.find((r) => r.id === id);
  if (!row) throw notFound();
  return toDto(row, rows, plansByZone(rows, templates).get(id) ?? []);
}

function mutationError(error: unknown): never {
  const info = classifyD1Error(error);
  if (info?.kind === 'unique')
    throw /scan_zones\.org_id, scan_zones\.key|scan_zones_org_key/.test(info.detail)
      ? new ConflictError('That key is already in use.', 'ZONE_KEY_TAKEN')
      : new ConflictError('Another zone already has that name.', 'ZONE_NAME_TAKEN');
  throw error;
}

/** Clear at needs a clock: a root zone's time zone. Checked for the zone and every zone below it. */
function assertClocks(rows: readonly ZoneRow[], id: string): void {
  const index = indexZones(rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const node of subtree(index, id))
    if (byId.get(node.id)?.clearAt && effectiveTimeZone(index, node.id) === null)
      throw invalid('Set a time zone on the top zone first.', 'ZONE_CLEAR_NEEDS_TZ');
}

export async function createZone(
  ctx: ServiceContext,
  userId: string,
  input: Create,
  authority: Authority,
) {
  assertAuthority(authority, input.orgId, 'scanning:manage');
  if (!(await orgIsActive(ctx.env.DB, input.orgId)))
    throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  const rows = await orgZoneRows(ctx.env.DB, input.orgId);
  const parentId = input.parentId ?? null;
  const parent = parentId === null ? null : rows.find((r) => r.id === parentId);
  if (parentId !== null && (!parent || parent.archivedAt !== null)) throw notFound();
  const id = ctx.ids.id();
  const timeZone = input.timeZone ?? null;
  if (parentId !== null && timeZone !== null)
    throw invalid('Only the top zone has a time zone.', 'ZONE_CHILD_TZ');
  assertPlacement(indexZones(rows), id, parentId);
  const now = ctx.clock.now();
  const values = {
    id,
    key: input.key,
    name: input.name,
    parentId,
    timeZone,
    sort: input.sort ?? 0,
    occupancy: input.occupancy ?? ('off' as const),
    capacity: input.capacity ?? null,
    maxStayMinutes: input.maxStayMinutes ?? null,
    clearAt: input.clearAt ?? null,
  };
  assertClocks(
    [...rows, { ...values, orgId: input.orgId, archivedAt: null, updatedAt: now, sessions: 0 }],
    id,
  );
  const g = adminGrant(
    ctx,
    'org.scan.zone.create',
    userId,
    authority,
    input.orgId,
    parentId === null ? [] : [...zonesOpen([parentId]), zoneFitsUnder(id, parentId)],
    ZONE_CODES,
    id,
  );
  addZoneInsert(g, values, userId, now);
  g.add(
    audited(g, ctx, {
      orgId: input.orgId,
      actorType: 'user',
      actorId: userId,
      action: 'scan_zone.create',
      targetType: 'scan_zone',
      targetId: id,
      detail: { parent: parentId !== null, occupancy: values.occupancy },
    }),
  );
  try {
    await g.commit();
  } catch (error) {
    mutationError(error);
  }
  return committed(ctx, input.orgId, id);
}

export async function updateZone(
  ctx: ServiceContext,
  userId: string,
  orgId: string,
  id: string,
  input: Update,
  authority: Authority,
) {
  assertAuthority(authority, orgId, 'scanning:manage');
  const rows = await orgZoneRows(ctx.env.DB, orgId);
  const row = rows.find((r) => r.id === id);
  if (!row) throw notFound();
  const { archived, ...fields } = input;
  const edits = Object.keys(fields).length > 0;
  if (edits && row.archivedAt !== null && archived !== false)
    throw invalid('This zone is archived.', 'ZONE_ARCHIVED');
  const parentId = input.parentId === undefined ? row.parentId : input.parentId;
  if (input.parentId !== undefined && input.parentId !== null) {
    const parent = rows.find((r) => r.id === input.parentId);
    if (!parent || parent.archivedAt !== null) throw notFound();
  }
  const next: ZoneRow = {
    ...row,
    parentId,
    name: input.name ?? row.name,
    timeZone: input.timeZone === undefined ? row.timeZone : input.timeZone,
    occupancy: input.occupancy ?? row.occupancy,
    capacity: input.capacity === undefined ? row.capacity : input.capacity,
    maxStayMinutes: input.maxStayMinutes === undefined ? row.maxStayMinutes : input.maxStayMinutes,
    clearAt: input.clearAt === undefined ? row.clearAt : input.clearAt,
  };
  if (input.parentId !== undefined) assertPlacement(indexZones(rows), id, parentId);
  if (next.parentId !== null && next.timeZone !== null)
    throw invalid('Only the top zone has a time zone.', 'ZONE_CHILD_TZ');
  if (next.occupancy === 'off' && (next.capacity ?? next.maxStayMinutes ?? next.clearAt) !== null)
    throw invalid('Turn on tracking first.', 'ZONE_NEEDS_TRACKING');
  assertClocks(
    rows.map((r) => (r.id === id ? next : r)),
    id,
  );
  const now = ctx.clock.now();
  const tree = subtree(indexZones(rows), id).map((n) => n.id);
  const archive = archived === true && row.archivedAt === null;
  const restore = archived === false && row.archivedAt !== null;
  if (restore && parentId !== null && rows.find((r) => r.id === parentId)?.archivedAt !== null)
    throw invalid('Restore the zone it sits in first.', 'ZONE_PARENT_ARCHIVED');
  const g = adminGrant(
    ctx,
    'org.scan.zone.update',
    userId,
    authority,
    orgId,
    [
      ...(input.parentId
        ? [...zonesOpen([input.parentId]), zoneFitsUnder(id, input.parentId)]
        : []),
      ...(archive || restore ? [zoneSubtreeIs(id, tree)] : []),
    ],
    ZONE_CODES,
    id,
  );
  addZoneUpdate(
    g,
    id,
    {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
      ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
      ...(input.sort === undefined ? {} : { sort: input.sort }),
      ...(input.occupancy === undefined ? {} : { occupancy: input.occupancy }),
      ...(input.capacity === undefined ? {} : { capacity: input.capacity }),
      ...(input.maxStayMinutes === undefined ? {} : { maxStayMinutes: input.maxStayMinutes }),
      ...(input.clearAt === undefined ? {} : { clearAt: input.clearAt }),
    },
    now,
  );
  // Children follow: a zone under an archived one would be unreachable.
  if (archive) addZoneArchive(g, tree, now, now);
  if (restore) addZoneArchive(g, tree, null, now);
  g.add(
    audited(g, ctx, {
      orgId,
      actorType: 'user',
      actorId: userId,
      action: archive ? 'scan_zone.archive' : restore ? 'scan_zone.restore' : 'scan_zone.update',
      targetType: 'scan_zone',
      targetId: id,
      detail: { fields: Object.keys(fields), zones: archive || restore ? tree.length : 1 },
    }),
  );
  try {
    await g.commit();
  } catch (error) {
    mutationError(error);
  }
  return committed(ctx, orgId, id);
}

export const archiveZone = (
  ctx: ServiceContext,
  userId: string,
  orgId: string,
  id: string,
  archived: boolean,
  authority: Authority,
) => updateZone(ctx, userId, orgId, id, { archived }, authority);
