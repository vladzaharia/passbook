import type { z } from 'zod';
import type {
  CreateLinkSchema,
  LinkDto,
  LinkListQuerySchema,
} from '../../../shared/contracts/connections-links.ts';
import type { Actor } from '../../platform/context.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import type { ConnectionAuthority } from './access.ts';
import {
  deleteLink,
  getLink,
  insertLink,
  type LinkFilter,
  type LinkRow,
  linkDto,
  listLinks,
  livePassInOrg,
} from './repo-links.ts';
import { auditActor, requireConnection } from './service-shared.ts';

type Query = z.infer<typeof LinkListQuerySchema>;
type Page = { items: LinkDto[]; nextCursor: string | null };

const linkNotFound = () => new NotFoundError('Link not found.', 'LINK_NOT_FOUND');
const linkTaken = () =>
  new ConflictError('That upstream object or pass is already linked.', 'LINK_EXISTS');

/** One page of an org's links. The cursor is the last link id. */
export async function findLinks(
  ctx: ServiceContext,
  orgId: string,
  filter: LinkFilter,
  query: Pick<Query, 'cursor' | 'limit'>,
): Promise<Page> {
  const rows = await listLinks(ctx, orgId, filter, query.cursor, query.limit + 1);
  const page = rows.slice(0, query.limit);
  return {
    items: page.map(linkDto),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function listConnectionLinks(
  ctx: ServiceContext,
  connectionId: string,
  query: Query,
): Promise<Page> {
  const conn = await requireConnection(ctx, connectionId);
  const { objectType, externalId } = query;
  return findLinks(ctx, conn.orgId, { connectionId, objectType, externalId }, query);
}

/** Links a pass to another upstream object. The pass's own binding is the primary link and is never added here. */
export async function bindLink(
  ctx: ServiceContext,
  actor: Actor,
  connectionId: string,
  input: z.infer<typeof CreateLinkSchema>,
  authority: ConnectionAuthority,
): Promise<LinkDto> {
  const conn = await requireConnection(ctx, connectionId);
  if (!(await livePassInOrg(ctx, conn.orgId, input.localId)))
    throw new ValidationError('The pass does not belong to this organization.', [
      { path: 'localId', message: 'Unknown pass', code: 'custom' },
    ]);
  const now = ctx.clock.now();
  const row: LinkRow = {
    id: ctx.ids.id(),
    org_id: conn.orgId,
    connection_id: connectionId,
    object_type: input.objectType,
    external_id: input.externalId,
    local_id: input.localId,
    role: 'secondary',
    state: 'active',
    created_at: now,
    updated_at: now,
  };
  try {
    if (!(await insertLink(ctx, { orgId: conn.orgId, authority }, row)))
      throw new ConflictError('The connection changed. Retry.', 'CONNECTION_CONFLICT');
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed: connection_links/.test(error.message))
      throw linkTaken();
    throw error;
  }
  await recordAudit(ctx, {
    orgId: conn.orgId,
    ...auditActor(actor),
    action: 'connection.link',
    targetType: 'connection',
    targetId: connectionId,
    detail: { linkId: row.id, objectType: row.object_type },
  });
  return linkDto(row);
}

export async function unbindLink(
  ctx: ServiceContext,
  actor: Actor,
  connectionId: string,
  linkId: string,
  authority: ConnectionAuthority,
): Promise<void> {
  const conn = await requireConnection(ctx, connectionId);
  const link = await getLink(ctx, conn.orgId, connectionId, linkId);
  if (!link) throw linkNotFound();
  if (link.role === 'primary')
    throw new ConflictError('Unbind the pass from the connection instead.', 'LINK_PRIMARY');
  if (!(await deleteLink(ctx, { orgId: conn.orgId, authority }, connectionId, linkId)))
    throw linkNotFound();
  await recordAudit(ctx, {
    orgId: conn.orgId,
    ...auditActor(actor),
    action: 'connection.unlink',
    targetType: 'connection',
    targetId: connectionId,
    detail: { linkId, objectType: link.object_type },
  });
}
