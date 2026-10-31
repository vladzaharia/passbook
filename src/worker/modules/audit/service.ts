import { run } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

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

/** Every module records mutations through this. Workstream g owns and may extend it. */
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
      entry.detail ? JSON.stringify(entry.detail) : null,
    ],
  );
}
