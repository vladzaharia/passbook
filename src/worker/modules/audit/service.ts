import type { z } from 'zod';
import type { AuditEntrySchema, AuditQuerySchema } from '../../../shared/contracts/audit.ts';
import type { Actor } from '../../platform/context.ts';
import { run } from '../../platform/db.ts';
import { ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { redactDetail } from './redact.ts';
import { type AuditRow, listAuditRows } from './repo.ts';

export { diffFields, redact, redactDetail } from './redact.ts';

export type AuditActorType = 'user' | 'api_key' | 'system' | 'connection' | 'device';

export interface AuditEntry {
  orgId?: string | null;
  actorType: AuditActorType;
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  ipPrefix?: string | null;
  /** Redacted diff. Never include secrets, tokens or personalization values. */
  detail?: Record<string, unknown> | null;
}

/** Audit fields for a request actor. */
export function auditActor(actor: Actor): Pick<AuditEntry, 'actorType' | 'actorId'> {
  return { actorType: actor.type, actorId: actor.id };
}

/** Every module records mutations through this. Detail is redacted again here as a backstop. */
export async function recordAudit(ctx: ServiceContext, entry: AuditEntry): Promise<void> {
  await run(
    ctx.env.DB,
    `INSERT INTO audit_log (at, org_id, actor_type, actor_id, action, target_type, target_id, request_id, ip_prefix, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ctx.clock.now(),
      entry.orgId ?? null,
      entry.actorType,
      entry.actorId ?? null,
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      ctx.requestId,
      entry.ipPrefix ?? null,
      entry.detail ? JSON.stringify(redactDetail(entry.detail)) : null,
    ],
  );
}

type Query = z.infer<typeof AuditQuerySchema>;
type Dto = z.infer<typeof AuditEntrySchema>;

function decodeCursor(cursor: string | undefined): number | undefined {
  if (!cursor) return undefined;
  const id = /^\d+$/.test(cursor) ? Number(cursor) : Number.NaN;
  if (!Number.isSafeInteger(id)) throw new ValidationError('Invalid cursor.', [], 'INVALID_CURSOR');
  return id;
}

function toDto(row: AuditRow): Dto {
  return {
    id: row.id,
    at: row.at,
    orgId: row.org_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
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
  return {
    items: page.map(toDto),
    nextCursor: rows.length > query.limit && last ? String(last.id) : null,
  };
}
