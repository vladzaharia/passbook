import type { Mode } from '../../../shared/contracts/common.ts';
import { all } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import { endBinding } from '../nfc/repo-tags-write.ts';
import { triggerRefusal } from '../nfc/tags.ts';
import type { ScanActor } from './guard.ts';
import { scanWriteGrant } from './scan-write-grant.ts';
import { scannerRefusal } from './scanner-credential-lost.ts';
import { TABLES } from './tags-bind.ts';

/** The loaner tags a pass holds now: active pass-scope bindings of a tag whose type is for visitors. */
export async function lentBindings(
  db: D1Database,
  orgId: string,
  mode: Mode,
  passId: string,
): Promise<{ id: string; tagId: string }[]> {
  const rows = await all<{ id: string; tag_id: string }>(
    db,
    `SELECT b.id, b.tag_id FROM tag_bindings b
     JOIN nfc_tags t ON t.id = b.tag_id AND t.org_id = ? AND t.mode = ?
     JOIN nfc_tag_types y ON y.id = t.type_id AND y.org_id = t.org_id AND y.use = 'visitor'
     WHERE b.pass_id = ? AND b.scope = 'pass' AND b.ended_at IS NULL`,
    [orgId, mode, passId],
  );
  return rows.map((r) => ({ id: r.id, tagId: r.tag_id }));
}

/** Ends the pass's loaner bindings at the desk: handed back, or kept (the tag is reported lost, by this actor). */
export async function collectTags(
  ctx: ServiceContext,
  actor: ScanActor,
  pass: { id: string; templateId: string },
  bindings: readonly { id: string; tagId: string }[],
  as: 'returned' | 'not_returned',
): Promise<void> {
  const now = ctx.clock.now();
  const by = actor.staff
    ? { type: 'staff' as const, id: actor.staff.id }
    : { type: actor.actor.type, id: actor.actor.id };
  const cause = as === 'returned' ? 'visitor_out' : 'lost';
  const g = scanWriteGrant(ctx, actor, {
    purpose: 'org_mode.scan.tag.unbind',
    now,
    pausedSession: true,
    templateId: pass.templateId,
    codes: { stale: 'TAG_NOT_LENT' },
    tables: TABLES,
  });
  for (const binding of bindings) {
    endBinding(g, binding, cause, by, now);
    grantedAudit(g, ctx, {
      orgId: actor.orgId,
      actorType: actor.actor.type === 'scanner' ? 'scanner' : 'user',
      actorId: actor.actor.id,
      action: as === 'returned' ? 'tag.unbind' : 'tag.lost',
      targetType: 'tag',
      targetId: binding.tagId,
      detail: {
        cause,
        scope: 'pass',
        passId: pass.id,
        bindingId: binding.id,
        ...(actor.apiKeyId ? { apiKeyId: actor.apiKeyId } : {}),
        ...(actor.staff ? { staffId: actor.staff.id } : {}),
      },
    });
  }
  try {
    await g.commit();
  } catch (error) {
    throw await scannerRefusal(ctx, actor, triggerRefusal(error) ?? error);
  }
}
