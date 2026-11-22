import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import type {
  CreateScanZoneSchema,
  ScanZoneListQuerySchema,
  UpdateScanZoneSchema,
} from '../../../shared/contracts/scan-access.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { addDueRecompute } from './occupancy/recompute.ts';
import { addZoneTapOut } from './occupancy/service.ts';
import { accessTemplates } from './repo-access.ts';
import { adminActorOf, adminGrant, audited } from './repo-admin-grant.ts';
import { readOrgTimeZone } from './repo-org-clock.ts';
import {
  addZoneArchive,
  addZoneUpdate,
  checkedAtByZone,
  orgZoneRows,
  type ZoneRow,
  zoneFitsUnder,
  zoneSubtreeIs,
  zonesOpen,
} from './repo-zones.ts';
import { newCapture } from './setup-capture.ts';
import { type Authority, assertAuthority, committed, notFound, toDto } from './zones-dto.ts';
import { plansByZone } from './zones-plans.ts';
import {
  assertClocks,
  invalid,
  mutationError,
  planZone,
  ZONE_CODES,
  zoneStatements,
} from './zones-statements.ts';
import { assertPlacement, indexZones, subtree, treeOrder } from './zones-tree.ts';

type Query = z.infer<typeof ScanZoneListQuerySchema> & { orgId: string };
type Create = z.infer<typeof CreateScanZoneSchema>;
type Update = z.infer<typeof UpdateScanZoneSchema>;

export async function listZones(
  ctx: ServiceContext,
  authority: Authority,
  query: Query,
  mode: Mode,
) {
  assertAuthority(authority, query.orgId, 'scanning:read');
  const [rows, templates, checked, clock] = await Promise.all([
    orgZoneRows(ctx.env.DB, query.orgId),
    accessTemplates(ctx.env.DB, query.orgId),
    checkedAtByZone(ctx.env.DB, query.orgId, mode),
    readOrgTimeZone(ctx.env.DB, query.orgId),
  ]);
  const plans = plansByZone(rows, templates);
  const shown = treeOrder(
    rows.filter((r) => (query.archived === 'true' ? r.archivedAt !== null : r.archivedAt === null)),
  );
  const start = query.cursor ? shown.findIndex((r) => r.id === query.cursor) + 1 : 0;
  const page = shown.slice(start, start + query.limit);
  return {
    // The console keeps the count of every session that uses the zone; a key sees its own mode's.
    items: page.map((r) =>
      toDto(
        authority.kind === 'api_key' ? { ...r, sessions: checked.get(r.id)?.length ?? 0 } : r,
        rows,
        plans.get(r.id) ?? [],
        checked.get(r.id) ?? [],
        clock,
      ),
    ),
    nextCursor: start + query.limit < shown.length ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function createZone(
  ctx: ServiceContext,
  userId: string,
  input: Create,
  authority: Authority,
  mode: Mode,
) {
  const capture = newCapture({ userId, authority, orgId: input.orgId, mode });
  const plan = await planZone(ctx, input, capture);
  const g = adminGrant(
    ctx,
    'org.scan.zone.create',
    userId,
    authority,
    input.orgId,
    plan.checks,
    ZONE_CODES,
    plan.values.id,
  );
  const { id } = zoneStatements(g, ctx, plan, capture);
  try {
    await g.commit();
  } catch (error) {
    mutationError(error);
  }
  return committed(ctx, input.orgId, id, mode, authority.kind === 'api_key');
}

export async function updateZone(
  ctx: ServiceContext,
  userId: string,
  orgId: string,
  id: string,
  input: Update,
  authority: Authority,
  mode: Mode,
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
    hardLimit: input.hardLimit ?? (input.capacity === null ? false : row.hardLimit),
  };
  if (input.parentId !== undefined) assertPlacement(indexZones(rows), id, parentId);
  if (next.parentId !== null && next.timeZone !== null)
    throw invalid('Only the top zone has a time zone.', 'ZONE_CHILD_TZ');
  if (next.occupancy === 'off' && (next.capacity ?? next.maxStayMinutes ?? next.clearAt) !== null)
    throw invalid('Turn on tracking first.', 'ZONE_NEEDS_TRACKING');
  if (next.hardLimit && next.capacity === null)
    throw invalid('Set a capacity first.', 'ZONE_NEEDS_CAPACITY');
  const orgClock = await readOrgTimeZone(ctx.env.DB, orgId);
  assertClocks(
    rows.map((r) => (r.id === id ? next : r)),
    id,
    orgClock,
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
    ['scan_zones', 'scan_presence'],
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
      ...(next.hardLimit === row.hardLimit ? {} : { hardLimit: next.hardLimit }),
    },
    now,
  );
  // Children follow: a zone under an archived one would be unreachable.
  if (archive) addZoneArchive(g, tree, now, now);
  if (restore) addZoneArchive(g, tree, null, now);
  // The tree's in(child) => in(parent) no longer holds: everyone inside it and below falls due now.
  const moved = input.parentId !== undefined && input.parentId !== row.parentId;
  if (archive || moved || (row.occupancy !== 'off' && next.occupancy === 'off'))
    addZoneTapOut(g, tree, now);
  else if (next.occupancy !== 'off') {
    // Max stay, Clear at or the clock moved: the passes inside get their new due time.
    const clock = input.timeZone !== undefined && input.timeZone !== row.timeZone;
    if (clock || next.maxStayMinutes !== row.maxStayMinutes || next.clearAt !== row.clearAt)
      await addDueRecompute(
        g,
        ctx.env.DB,
        orgId,
        rows.map((r) => (r.id === id ? next : r)),
        clock ? tree : [id],
        now,
        orgClock,
      );
  }
  g.add(
    audited(g, ctx, {
      orgId,
      ...adminActorOf(authority, userId),
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
  return committed(ctx, orgId, id, mode, authority.kind === 'api_key');
}

export const archiveZone = (
  ctx: ServiceContext,
  userId: string,
  orgId: string,
  id: string,
  archived: boolean,
  authority: Authority,
  mode: Mode,
) => updateZone(ctx, userId, orgId, id, { archived }, authority, mode);
