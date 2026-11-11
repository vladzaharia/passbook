import type { z } from 'zod';
import type { AuditEntrySchema, AuditQuerySchema } from '../../../shared/contracts/audit.ts';
import type { OrgMembership } from '../../../shared/contracts/org-membership.ts';
import type { Actor } from '../../platform/context.ts';
import { ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireOrgCapability } from '../orgs/access.ts';
import { redactForRead, safeLabel } from './redact.ts';
import { type AuditRow, auditStmt, labelKey, listAuditRows, loadLabels } from './repo.ts';
import type { AuditEntry } from './types.ts';

export { diffFields } from './redact.ts';

/** Audit fields for a request actor. */
export function auditActor(actor: Actor): Pick<AuditEntry, 'actorType' | 'actorId'> {
  return { actorType: actor.type, actorId: actor.id };
}

/** Every module records mutations through this. Detail is redacted again here as a backstop. */
export async function recordAudit(ctx: ServiceContext, entry: AuditEntry): Promise<void> {
  await auditStmt(ctx.env.DB, ctx, entry).run();
}

type Query = z.infer<typeof AuditQuerySchema>;
type Dto = z.infer<typeof AuditEntrySchema>;

function decodeCursor(cursor: string | undefined): number | undefined {
  if (!cursor) return undefined;
  const id = /^\d+$/.test(cursor) ? Number(cursor) : Number.NaN;
  if (!Number.isSafeInteger(id)) throw new ValidationError('Invalid cursor.', [], 'INVALID_CURSOR');
  return id;
}

type AuditScope =
  | { kind: 'tenant'; orgId: string; userId: string; membershipId: string }
  | { kind: 'platform' };

// UUIDs are identifiers, not capability tokens. Other secret-looking values are omitted.
function safeId(id: string | null): string | null {
  if (!id) return null;
  return /^(?:org:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? id
    : safeLabel(id);
}

function toDto(row: AuditRow, labels: Map<string, string | null>, tenant: boolean): Dto {
  const actorKey = row.actor_id ? labelKey(row.actor_type, row.actor_id) : null;
  const targetKey =
    row.target_type && row.target_id ? labelKey(row.target_type, row.target_id) : null;
  const actorId = !tenant || (actorKey && labels.has(actorKey)) ? safeId(row.actor_id) : null;
  const targetId = !tenant || (targetKey && labels.has(targetKey)) ? safeId(row.target_id) : null;
  return {
    id: row.id,
    at: row.at,
    orgId: row.org_id,
    actorType: row.actor_type,
    actorId,
    actorLabel: actorId && actorKey ? (labels.get(actorKey) ?? null) : null,
    action: row.action,
    targetType: row.target_type,
    targetId,
    targetLabel: targetId && targetKey ? (labels.get(targetKey) ?? null) : null,
    requestId: safeId(row.request_id),
    detail: row.detail ? (redactForRead(JSON.parse(row.detail), tenant) as Dto['detail']) : null,
  };
}

export async function listTenantAudit(ctx: ServiceContext, userId: string, query: Query) {
  if (!query.orgId) throw new ValidationError('Choose an organization.', [], 'ORG_REQUIRED');
  const membership: OrgMembership = await requireOrgCapability(
    ctx,
    userId,
    query.orgId,
    'audit:read',
  );
  return listAudit(ctx, query, {
    kind: 'tenant',
    orgId: query.orgId,
    userId,
    membershipId: membership.id,
  });
}

export async function listPlatformAudit(ctx: ServiceContext, query: Query) {
  return listAudit(ctx, query, { kind: 'platform' });
}

async function listAudit(
  ctx: ServiceContext,
  query: Query,
  scope: AuditScope,
): Promise<{ items: Dto[]; nextCursor: string | null }> {
  const rows = await listAuditRows(
    ctx.env.DB,
    {
      orgId: scope.kind === 'tenant' ? scope.orgId : query.orgId,
      ...(scope.kind === 'tenant'
        ? { tenant: { userId: scope.userId, membershipId: scope.membershipId } }
        : {}),
      actorId: query.actorId,
      action: query.action,
      excludeAction: query.excludeAction,
      targetType: query.targetType,
      targetId: query.targetId,
      from: query.from,
      to: query.to,
      before: decodeCursor(query.cursor),
    },
    query.limit + 1,
  );
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const refs = page.flatMap((r) => [
    ...(r.actor_id ? [{ type: r.actor_type, id: r.actor_id }] : []),
    ...(r.target_type && r.target_id ? [{ type: r.target_type, id: r.target_id }] : []),
  ]);
  const labels = await loadLabels(
    ctx.env.DB,
    refs,
    scope.kind === 'tenant' ? scope.orgId : undefined,
  );
  return {
    items: page.map((r) => toDto(r, labels, scope.kind === 'tenant')),
    nextCursor: rows.length > query.limit && last ? String(last.id) : null,
  };
}
