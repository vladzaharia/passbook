import type { Mode } from '../../../shared/contracts/common.ts';
import type { ScanZone } from '../../../shared/contracts/scan-access.ts';
import { scopeExercises } from '../../platform/api-scopes.ts';
import { ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { accessTemplates } from './repo-access.ts';
import { readOrgTimeZone } from './repo-org-clock.ts';
import { checkedAtByZone, orgZoneRows, type ZoneRow } from './repo-zones.ts';
import { plansByZone } from './zones-plans.ts';
import { depthOf, effectiveTimeZone, indexZones } from './zones-tree.ts';

/** A console session, or a key whose verified scope `tenantAuthorityOf` proved for the capability. */
export type Authority = TenantPassWrite;
export const notFound = () => new NotFoundError('Zone not found.', 'ZONE_NOT_FOUND');

export function assertAuthority(
  authority: Authority,
  orgId: string,
  capability: 'scanning:read' | 'scanning:manage',
): void {
  if (
    authority.orgId !== orgId ||
    (authority.kind === 'session' && authority.capability !== capability) ||
    (authority.kind === 'api_key' && !scopeExercises(authority.scope, capability))
  )
    throw new ForbiddenError();
}

export function toDto(
  row: ZoneRow,
  rows: readonly ZoneRow[],
  plans: ScanZone['plans'],
  checkedAt: ScanZone['checkedAt'],
  orgTimeZone: string | null,
): ScanZone {
  const index = indexZones(rows);
  return {
    id: row.id,
    orgId: row.orgId,
    key: row.key,
    name: row.name,
    parentId: row.parentId,
    timeZone: row.timeZone,
    effectiveTimeZone: effectiveTimeZone(index, row.id, orgTimeZone),
    sort: row.sort,
    depth: depthOf(index, row.id),
    occupancy: row.occupancy,
    capacity: row.capacity,
    maxStayMinutes: row.maxStayMinutes,
    clearAt: row.clearAt,
    hardLimit: row.hardLimit,
    sessions: row.sessions,
    checkedAt,
    plans,
    inNow: null, // set by the occupancy package
    archivedAt: row.archivedAt,
  };
}

export async function committed(
  ctx: ServiceContext,
  orgId: string,
  id: string,
  mode: Mode,
): Promise<ScanZone> {
  const [rows, templates, checked, clock] = await Promise.all([
    orgZoneRows(ctx.env.DB, orgId),
    accessTemplates(ctx.env.DB, orgId),
    checkedAtByZone(ctx.env.DB, orgId, mode),
    readOrgTimeZone(ctx.env.DB, orgId),
  ]);
  const row = rows.find((r) => r.id === id);
  if (!row) throw notFound();
  return toDto(row, rows, plansByZone(rows, templates).get(id) ?? [], checked.get(id) ?? [], clock);
}
