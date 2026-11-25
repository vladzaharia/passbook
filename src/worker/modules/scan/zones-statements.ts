import type { z } from 'zod';
import type { CreateScanZoneSchema } from '../../../shared/contracts/scan-access.ts';
import type { Grant } from '../../platform/authority.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { classifyD1Error } from '../../platform/db.ts';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { orgIsActive } from '../orgs/repo.ts';
import { adminActorOf, audited, createdByOf } from './repo-admin-grant.ts';
import { readOrgTimeZone } from './repo-org-clock.ts';
import {
  addZoneInsert,
  orgZoneRows,
  type ZoneInsert,
  type ZoneRow,
  zoneFitsUnder,
  zonesOpen,
} from './repo-zones.ts';
import type { SetupCapture } from './setup-capture.ts';
import { assertAuthority, notFound } from './zones-dto.ts';
import { assertPlacement, effectiveTimeZone, indexZones, subtree } from './zones-tree.ts';

export type CreateZone = z.infer<typeof CreateScanZoneSchema>;

export const ZONE_CODES = { config: 'SCAN_ZONE_CHANGED', lineage: 'SCAN_ZONE_CHANGED' } as const;
export const invalid = (message: string, code: string) => new ValidationError(message, [], code);

export function mutationError(error: unknown): never {
  const info = classifyD1Error(error);
  if (info?.kind === 'unique')
    throw /scan_zones\.org_id, scan_zones\.key|scan_zones_org_key/.test(info.detail)
      ? new ConflictError('That key is already in use.', 'ZONE_KEY_TAKEN')
      : new ConflictError('Another zone already has that name.', 'ZONE_NAME_TAKEN');
  throw error;
}

/**
 * Clear at needs a clock: a root zone's time zone, else the org's. Checked for the zone and every
 * zone below it. Every org has a clock now (its zone, else Seattle), so this only fires for a caller
 * that passes no org zone.
 */
export function assertClocks(
  rows: readonly ZoneRow[],
  id: string,
  orgTimeZone: string | null,
): void {
  const index = indexZones(rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const node of subtree(index, id))
    if (byId.get(node.id)?.clearAt && effectiveTimeZone(index, node.id, orgTimeZone) === null)
      throw invalid(
        'Set a time zone on the top zone or the organization.',
        'ZONE_CLEAR_NEEDS_TIME_ZONE',
      );
}

export interface ZonePlan {
  values: ZoneInsert;
  /** Checks for the grant; a parent made in the same batch needs none, it is placed in memory. */
  checks: Check[];
}

/**
 * The reads and rules of a zone create: the org is active, the parent is a live zone of the org
 * (or one this batch plans earlier), the placement and clocks hold. Nothing is written; the zone
 * joins the capture so later plans may point at it.
 */
export async function planZone(
  ctx: ServiceContext,
  input: CreateZone,
  capture: SetupCapture,
): Promise<ZonePlan> {
  const { authority } = capture;
  // Zones are org-wide, not moded: a key makes them in live mode only (the one-call setup).
  if (authority.kind === 'api_key') {
    if (authority.orgId !== input.orgId) throw new ForbiddenError();
    if (authority.mode !== 'live')
      throw new ForbiddenError('Zones need a live key.', 'SCAN_ZONE_LIVE_ONLY');
  } else assertAuthority(authority, input.orgId, 'scanning:manage');
  if (!(await orgIsActive(ctx.env.DB, input.orgId)))
    throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  const rows = [...(await orgZoneRows(ctx.env.DB, input.orgId)), ...capture.zones.values()];
  const parentId = input.parentId ?? null;
  const parent = parentId === null ? null : rows.find((r) => r.id === parentId);
  if (parentId !== null && (!parent || parent.archivedAt !== null)) throw notFound();
  const id = ctx.ids.id();
  const timeZone = input.timeZone ?? null;
  if (parentId !== null && timeZone !== null)
    throw invalid('Only the top zone has a time zone.', 'ZONE_CHILD_TZ');
  assertPlacement(indexZones(rows), id, parentId);
  if (input.hardLimit && input.capacity == null)
    throw invalid('Set a capacity first.', 'ZONE_NEEDS_CAPACITY');
  const values: ZoneInsert = {
    id,
    key: input.key,
    name: input.name,
    parentId,
    timeZone,
    sort: input.sort ?? 0,
    occupancy: input.occupancy ?? 'off',
    capacity: input.capacity ?? null,
    maxStayMinutes: input.maxStayMinutes ?? null,
    clearAt: input.clearAt ?? null,
    hardLimit: input.hardLimit ?? false,
  };
  const now = ctx.clock.now();
  const row: ZoneRow = {
    ...values,
    orgId: input.orgId,
    archivedAt: null,
    updatedAt: now,
    sessions: 0,
  };
  assertClocks([...rows, row], id, await readOrgTimeZone(ctx.env.DB, input.orgId));
  const stored = parentId !== null && !capture.zones.has(parentId);
  capture.zones.set(id, row);
  return {
    values,
    checks: stored ? [...zonesOpen([parentId]), zoneFitsUnder(id, parentId)] : [],
  };
}

/** The zone row and its audit row. A duplicate key or name fails the batch: classify with `mutationError`. */
export function zoneStatements(
  g: Grant,
  ctx: ServiceContext,
  plan: ZonePlan,
  capture: SetupCapture,
): { id: string } {
  const { values } = plan;
  const now = ctx.clock.now();
  addZoneInsert(g, values, createdByOf(capture.authority, capture.userId), now);
  g.add(
    audited(g, ctx, {
      orgId: capture.orgId,
      ...adminActorOf(capture.authority, capture.userId),
      action: 'scan_zone.create',
      targetType: 'scan_zone',
      targetId: values.id,
      detail: { parent: values.parentId !== null, occupancy: values.occupancy },
    }),
  );
  return { id: values.id };
}
