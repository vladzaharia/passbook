import type { CheckInPolicy } from '../../../shared/contracts/check-in.ts';
import { CheckInPolicySchema } from '../../../shared/contracts/check-in.ts';
import { first, run } from '../../platform/db.ts';
import type { TenantPassWrite } from './http.ts';
import { tenantPassAuthorityParams, tenantPassAuthoritySql } from './repo-authority.ts';
import type { Pass } from './repo-map.ts';

export async function passCheckIn(db: D1Database, orgId: string, passId: string) {
  const row = await first<{ rules: string; updated_at: number }>(
    db,
    'SELECT rules,updated_at FROM pass_check_in WHERE org_id=? AND pass_id=?',
    [orgId, passId],
  );
  return {
    rules: CheckInPolicySchema.parse(JSON.parse(row?.rules ?? '{}')),
    updatedAt: row?.updated_at ?? null,
  };
}

export function savePassCheckIn(
  db: D1Database,
  orgId: string,
  passId: string,
  rules: CheckInPolicy,
  at: number,
  fence?: { authority: TenantPassWrite; pass: Pass },
) {
  if (
    fence &&
    (fence.authority.kind === 'session'
      ? fence.authority.capability !== 'passes:operate'
      : fence.authority.scope !== 'passes:write')
  )
    return Promise.resolve({ changes: 0 });
  const values = fence
    ? `SELECT p.id, p.org_id, ?, ? FROM passes p
       WHERE p.id = ? AND p.org_id = ? AND p.mode = ? AND p.version = ?
         AND p.template_id = ? AND p.template_version = ? AND p.serial = ? AND p.auth_token = ?
         AND p.holder_email IS ? AND p.owner_user_id IS ? AND p.link_generation = ?
         AND p.status = ? AND p.removed_at IS ? AND p.deleted_at IS NULL
         AND p.test_data_quarantined = 0
         AND (? IS NULL OR EXISTS (
           SELECT 1 FROM scan_events e WHERE e.id = ? AND e.org_id = p.org_id
             AND e.mode = p.mode AND e.archived_at IS NULL
         ))
         AND ${tenantPassAuthoritySql(fence.authority, 'p')}
         AND p.mode = ?`
    : 'VALUES(?,?,?,?)';
  const params = fence
    ? [
        JSON.stringify(rules),
        at,
        passId,
        orgId,
        fence.pass.mode,
        fence.pass.version,
        fence.pass.templateId,
        fence.pass.templateVersion,
        fence.pass.serial,
        fence.pass.authToken,
        fence.pass.holderEmail,
        fence.pass.ownerUserId,
        fence.pass.linkGeneration,
        fence.pass.status,
        fence.pass.removedAt,
        rules.eventId ?? null,
        rules.eventId ?? null,
        ...tenantPassAuthorityParams(fence.authority, at),
        fence.authority.mode,
      ]
    : [passId, orgId, JSON.stringify(rules), at];
  return run(
    db,
    `INSERT INTO pass_check_in(pass_id,org_id,rules,updated_at) ${values}
    ON CONFLICT(pass_id) DO UPDATE SET rules=excluded.rules,updated_at=excluded.updated_at
    WHERE pass_check_in.org_id=excluded.org_id`,
    params,
  );
}
