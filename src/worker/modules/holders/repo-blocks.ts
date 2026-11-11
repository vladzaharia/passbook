import { batch, stmt } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { redactDetail } from '../audit/redact.ts';
import type { AuditEntry } from '../audit/types.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { tenantPassAuthorityParams, tenantPassAuthoritySql } from '../passes/repo-authority.ts';
import type { HolderPass } from './repo.ts';

export type MutationAudit = { ctx: Pick<ServiceContext, 'clock' | 'requestId'>; entry: AuditEntry };

/** Immediately follows the mutation whose changes() it observes in the same batch. */
export function mutationAudit(db: D1Database, { ctx, entry }: MutationAudit): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO audit_log
       (at, org_id, actor_type, actor_id, action, target_type, target_id, request_id, ip_prefix, detail)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
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

export function operationAuthority(authority: TenantPassWrite): boolean {
  return authority.kind === 'session'
    ? authority.capability === 'passes:operate'
    : authority.scope === 'holders:write' || authority.scope === 'passes:write';
}

export async function removeBlock(
  db: D1Database,
  pass: HolderPass,
  userId: string,
  authority?: TenantPassWrite,
  now = 0,
  audit?: MutationAudit,
): Promise<boolean> {
  const deletion = stmt(
    db,
    `DELETE FROM pass_attach_blocks WHERE pass_id = ? AND user_id = ?
     AND EXISTS (SELECT 1 FROM passes WHERE id = pass_attach_blocks.pass_id
       AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
         WHERE t.pass_id = passes.id AND t.state = 'pending')
       AND org_id = ? AND mode = ? AND deleted_at IS NULL AND test_data_quarantined = 0)
     ${
       authority
         ? `AND ? = ? AND ? = ?
       AND ${operationAuthority(authority) ? tenantPassAuthoritySql(authority) : '0'}`
         : ''
     }
     RETURNING pass_id`,
    [
      pass.id,
      userId,
      pass.orgId,
      pass.mode,
      ...(authority
        ? [
            authority.orgId,
            pass.orgId,
            authority.mode,
            pass.mode,
            ...(operationAuthority(authority) ? tenantPassAuthorityParams(authority, now) : []),
          ]
        : []),
    ],
  );
  if (!audit) return (await deletion.first<{ pass_id: string }>()) !== null;
  const results = await batch(db, [deletion, mutationAudit(db, audit)]);
  return (results[0]?.results?.length ?? 0) > 0;
}
