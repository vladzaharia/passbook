import type { z } from 'zod';
import type { AuditEntrySchema, AuditQuerySchema } from '../../../shared/contracts/audit.ts';
import type { Actor } from '../../platform/context.ts';
import { ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
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

function toDto(row: AuditRow, labels: Map<string, string>): Dto {
  return {
    id: row.id,
    at: row.at,
    orgId: row.org_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    actorLabel: row.actor_id ? (labels.get(labelKey(row.actor_type, row.actor_id)) ?? null) : null,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    targetLabel:
      row.target_type && row.target_id
        ? (labels.get(labelKey(row.target_type, row.target_id)) ?? null)
        : null,
    requestId: row.request_id,
    detail: row.detail ? JSON.parse(row.detail) : null,
  };
}

export async function listAudit(
  ctx: ServiceContext,
  query: Query,
): Promise<{ items: Dto[]; nextCursor: string | null }> {
  const rows = await listAuditRows(
    ctx.env.DB,
    {
      orgId: query.orgId,
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
  const labels = await loadLabels(ctx.env.DB, refs);
  return {
    items: page.map((r) => toDto(r, labels)),
    nextCursor: rows.length > query.limit && last ? String(last.id) : null,
  };
}
