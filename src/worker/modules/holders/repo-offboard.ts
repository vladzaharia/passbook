import type { Mode } from '../../../shared/contracts/common.ts';
import { type Grant, grant } from '../../platform/authority.ts';
import { all } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import { endBinding } from '../nfc/repo-tags-write.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { capabilityChecks, tenantPrincipal } from '../passes/repo-authority.ts';

const CODES = { lineage: 'OFFBOARD_CHANGED', stale: 'OFFBOARD_CHANGED' } as const;
/** D1 allows 100 bound values per statement. */
const ID_CHUNK = 90;

const who = (a: TenantPassWrite) =>
  a.kind === 'session'
    ? ({ type: 'user', id: a.userId, key: `u:${a.userId}` } as const)
    : ({ type: 'api_key', id: a.keyId, key: `k:${a.keyId}` } as const);

export interface OffboardPass {
  id: string;
  who: string;
  voided: boolean;
}

/**
 * Passes of a person still to offboard, named by holder email or by external ID, in one org and mode, in id order.
 * Void: a voided pass counts only while a tag is still bound to it, so a repeated call moves on.
 */
export async function offboardPasses(
  db: D1Database,
  orgId: string,
  mode: Mode,
  by: { email: string } | { externalId: string },
  how: 'void' | 'remove',
  limit: number,
): Promise<OffboardPass[]> {
  const [column, value] =
    'email' in by ? ['holder_email', by.email] : ['external_id', by.externalId];
  const todo =
    how === 'void'
      ? `AND (status != 'voided' OR EXISTS (SELECT 1 FROM tag_bindings b WHERE b.pass_id = passes.id AND b.ended_at IS NULL))`
      : '';
  const rows = await all<{ id: string; who: string | null; status: string }>(
    db,
    `SELECT id, COALESCE(owner_user_id, holder_email, id) AS who, status FROM passes
     WHERE org_id = ? AND mode = ? AND ${column} = ? AND removed_at IS NULL AND deleted_at IS NULL ${todo}
     ORDER BY id LIMIT ?`,
    [orgId, mode, value, limit],
  );
  return rows.map((r) => ({ id: r.id, who: r.who ?? r.id, voided: r.status === 'voided' }));
}

/** Tag bindings still active on these passes, looked up in chunks under D1's bound-value limit. */
export async function activeBindingsOn(
  db: D1Database,
  passIds: string[],
): Promise<{ id: string; tagId: string }[]> {
  const found: { id: string; tagId: string }[] = [];
  for (let i = 0; i < passIds.length; i += ID_CHUNK) {
    const chunk = passIds.slice(i, i + ID_CHUNK);
    const rows = await all<{ id: string; tag_id: string }>(
      db,
      `SELECT id, tag_id FROM tag_bindings
       WHERE ended_at IS NULL AND pass_id IN (${chunk.map(() => '?').join(',')})`,
      chunk,
    );
    for (const r of rows) found.push({ id: r.id, tagId: r.tag_id });
  }
  return found;
}

/** Ends tag bindings for an offboarded person; `lost` also marks the tags reported lost. */
export function offboardTagsGrant(
  ctx: ServiceContext,
  a: TenantPassWrite,
  orgId: string,
  bindings: { id: string; tagId: string }[],
  lost: boolean,
): Grant {
  const g = grant(ctx, {
    purpose: 'org_mode.nfc.tag.offboard',
    principal: tenantPrincipal(a),
    checks: capabilityChecks(a),
    codes: CODES,
    tables: ['nfc_tags', 'tag_bindings'],
  });
  const now = ctx.clock.now();
  for (const b of bindings) {
    endBinding(g, b, 'offboard', { type: 'user', id: who(a).key }, now);
    if (lost)
      g.update('nfc_tags', {
        set: { lost_at: now, lost_by: who(a).key },
        where: { id: b.tagId, lost_at: null },
      });
  }
  grantedAudit(g, ctx, {
    orgId,
    actorType: who(a).type,
    actorId: who(a).id,
    action: 'tag.offboard',
    targetType: 'org',
    targetId: orgId,
    detail: { tags: bindings.length, lost },
  });
  return g;
}
