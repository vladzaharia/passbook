import { jobGrant } from '../../platform/authority.ts';
import { exists } from '../../platform/authority-cond.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import { lapsedBindings } from './repo-tag-bindings.ts';

const PAGE = 100;
/** One run ends at most this many; the rest wait for the next. The door refuses them meanwhile. */
const MAX_PER_RUN = 500;

/**
 * Ends the bindings whose expiry passed (`expired`, by the system); the tag becomes a spare. A bind of the same
 * holder or tag already ends a lapsed binding itself, so this only tidies what nobody touched. Idempotent: a
 * row another writer ended first is skipped.
 */
export async function expireBindings(ctx: ServiceContext): Promise<number> {
  const now = ctx.clock.now();
  let tried = 0;
  let ended = 0;
  while (tried < MAX_PER_RUN) {
    const page = await lapsedBindings(ctx.env.DB, now, Math.min(PAGE, MAX_PER_RUN - tried));
    if (page.length === 0) break;
    for (const row of page) {
      tried++;
      const g = jobGrant(ctx, {
        purpose: 'org_mode.job.nfc.binding_expire',
        job: 'nfc.binding_expire',
        orgId: row.orgId,
        mode: row.mode,
        tables: ['tag_bindings'],
      });
      g.joined('tag_bindings', {
        via: 'tag_id',
        where: { id: row.id, ended_at: null },
        set: { ended_at: now, ended_by_type: 'system', ended_by: 'expiry', end_cause: 'expired' },
      });
      grantedAudit(
        g,
        ctx,
        {
          orgId: row.orgId,
          actorType: 'system',
          actorId: null,
          action: 'tag.expire',
          targetType: 'tag',
          targetId: row.tagId,
          detail: { bindingId: row.id, passId: row.passId },
        },
        [exists('tag_bindings', { id: row.id, end_cause: 'expired' })],
      );
      await g.commit();
      ended++;
    }
    // A page that all failed to end would come back; the count above bounds that.
    if (page.length < PAGE) break;
  }
  if (ended > 0) ctx.log.info('tags.bindings_expired', { ended });
  return ended;
}
