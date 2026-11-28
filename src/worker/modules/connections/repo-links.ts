import type { LinkDto } from '../../../shared/contracts/connections-links.ts';
import { all, first, type SqlValue } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  type ConnectionActor,
  commitOrNull,
  connectionGrant,
  connectionIs,
} from './repo-grants.ts';

export interface LinkRow {
  id: string;
  org_id: string;
  connection_id: string;
  object_type: string;
  external_id: string;
  local_id: string;
  role: 'primary' | 'secondary';
  state: 'active' | 'tombstoned';
  created_at: number;
  updated_at: number;
}

export const linkDto = (r: LinkRow): LinkDto => ({
  id: r.id,
  connectionId: r.connection_id,
  objectType: r.object_type,
  externalId: r.external_id,
  localId: r.local_id,
  role: r.role,
  state: r.state,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export interface LinkFilter {
  connectionId?: string | undefined;
  objectType?: string | undefined;
  externalId?: string | undefined;
}

/** Links of one org by id order; `after` is the last id of the previous page. Never crosses the org. */
export async function listLinks(
  ctx: ServiceContext,
  orgId: string,
  filter: LinkFilter,
  after: string | undefined,
  limit: number,
): Promise<LinkRow[]> {
  const where = ['org_id = ?'];
  const params: SqlValue[] = [orgId];
  const add = (column: string, value: string | undefined) => {
    if (value === undefined) return;
    where.push(`${column} = ?`);
    params.push(value);
  };
  add('connection_id', filter.connectionId);
  add('object_type', filter.objectType);
  add('external_id', filter.externalId);
  if (after !== undefined) {
    where.push('id > ?');
    params.push(after);
  }
  return all<LinkRow>(
    ctx.env.DB,
    `SELECT * FROM connection_links WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`,
    [...params, limit],
  );
}

export function getLink(
  ctx: ServiceContext,
  orgId: string,
  connectionId: string,
  linkId: string,
): Promise<LinkRow | null> {
  return first<LinkRow>(
    ctx.env.DB,
    'SELECT * FROM connection_links WHERE id = ? AND connection_id = ? AND org_id = ?',
    [linkId, connectionId, orgId],
  );
}

/** A live pass of the org, the only local object a link can name today. */
export async function livePassInOrg(
  ctx: ServiceContext,
  orgId: string,
  passId: string,
): Promise<boolean> {
  const row = await first<{ id: string }>(
    ctx.env.DB,
    "SELECT id FROM passes WHERE id = ? AND org_id = ? AND mode = 'live'",
    [passId, orgId],
  );
  return row !== null;
}

/** Inserts a secondary link, fenced on the connection still existing in the actor's org. */
export async function insertLink(
  ctx: ServiceContext,
  actor: ConnectionActor,
  row: LinkRow,
): Promise<boolean> {
  const g = connectionGrant(
    ctx,
    actor,
    'link_bind',
    [connectionIs({ id: row.connection_id })],
    row.id,
  );
  g.insertSelect(
    'connection_links',
    [
      'id',
      'connection_id',
      'object_type',
      'external_id',
      'local_id',
      'role',
      'state',
      'created_at',
      'updated_at',
    ],
    [
      row.id,
      row.connection_id,
      row.object_type,
      row.external_id,
      row.local_id,
      row.role,
      row.state,
      row.created_at,
      row.updated_at,
    ],
  );
  return (await commitOrNull(g, actor)) !== null;
}

/** Deletes a secondary link; a primary link goes only with the pass's binding. */
export async function deleteLink(
  ctx: ServiceContext,
  actor: ConnectionActor,
  connectionId: string,
  linkId: string,
): Promise<boolean> {
  const g = connectionGrant(
    ctx,
    actor,
    'link_unbind',
    [connectionIs({ id: connectionId })],
    linkId,
  );
  const del = g.delete('connection_links', {
    where: { id: linkId, connection_id: connectionId, role: 'secondary' },
    returning: ['id'],
  });
  const results = await g.commit();
  return (results[g.indexOf(del)]?.results.length ?? 0) === 1;
}
