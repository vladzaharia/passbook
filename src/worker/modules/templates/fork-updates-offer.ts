import { templateMergeGrant } from '../../jobs/template-merge.ts';
import { exactlyOne } from '../../platform/authority-checks.ts';
import { notExists } from '../../platform/authority-cond.ts';
import { inList, lt } from '../../platform/authority-expr.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  fences,
  isStale,
  MAX_ATTEMPTS,
  RETRY_AFTER_MS,
  type UpdateKey,
} from './fork-updates-write.ts';
import type { ForkState } from './repo-fork-update-checks.ts';

/** A new pending offer, unless one exists for this (fork, ours, upstream). Null when refused or present. */
export async function insertPending(
  ctx: ServiceContext,
  u: Omit<UpdateKey, 'id'> & { baseVersion: string | null },
  state: ForkState,
  revision: number,
): Promise<string | null> {
  const id = ctx.ids.id();
  const key = { ...u, id };
  const g = templateMergeGrant(ctx, u.orgId, { checks: fences(key, state), target: id });
  const now = ctx.clock.now();
  const absent = notExists('template_fork_updates', {
    template_id: u.templateId,
    ours_version: u.oursVersion,
    upstream_version: u.upstreamVersion,
  });
  g.insertSelect(
    'template_fork_updates',
    [
      'id',
      'template_id',
      'upstream_id',
      'upstream_version',
      'base_version',
      'ours_version',
      'status',
      'engine_revision',
      'created_at',
      'updated_at',
    ],
    [
      id,
      u.templateId,
      u.upstreamId,
      u.upstreamVersion,
      u.baseVersion,
      u.oursVersion,
      'pending',
      revision,
      now,
      now,
    ],
    { when: [absent], returning: ['id'] },
  );
  try {
    const [inserted] = await g.commit();
    return (inserted?.results.length ?? 0) > 0 ? id : null;
  } catch (error) {
    if (isStale(error)) return null;
    throw error;
  }
}

/** Puts a pending or failed offer back to pending for another try, once it has sat for `RETRY_AFTER_MS`. */
export async function requeue(ctx: ServiceContext, u: UpdateKey): Promise<boolean> {
  const g = templateMergeGrant(ctx, u.orgId, {
    checks: [
      exactlyOne('template_forks', {
        template_id: u.templateId,
        upstream_id: u.upstreamId,
        tracking: 'on',
      }),
    ],
    target: u.id,
  });
  const now = ctx.clock.now();
  g.update('template_fork_updates', {
    set: { status: 'pending', updated_at: now },
    inc: ['attempts'],
    where: {
      id: u.id,
      status: inList(['pending', 'failed']),
      attempts: lt(MAX_ATTEMPTS),
      updated_at: lt(now - RETRY_AFTER_MS),
    },
    returning: ['id'],
  });
  try {
    const [done] = await g.commit();
    return (done?.results.length ?? 0) > 0;
  } catch (error) {
    if (isStale(error)) return false;
    throw error;
  }
}
