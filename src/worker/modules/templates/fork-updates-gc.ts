import type { ServiceContext } from '../../platform/service-context.ts';
import { r2Prefix } from './registry.ts';
import { forksWithOffers, versionExists } from './repo-fork-updates.ts';

/** Forks looked at, and objects deleted, per run. The most recently active forks come first. */
const FORKS = 50;
const DELETES = 200;
/** A merge puts its objects before its batch commits: younger objects may belong to a job in flight. */
const MIN_AGE_MS = 24 * 60 * 60_000;

/**
 * Daily: deletes objects under a fork's own prefix that no version of the fork references. A merge
 * that loses its fence leaves them behind. The key is `templates/<org>/<fork>/<version>/<name>`.
 */
export async function sweepForkOrphans(ctx: ServiceContext): Promise<void> {
  const cutoff = ctx.clock.now() - MIN_AGE_MS;
  let budget = DELETES;
  for (const fork of await forksWithOffers(ctx.env.DB, FORKS)) {
    if (budget <= 0) return;
    const prefix = r2Prefix(fork.orgId, fork.templateId);
    const listed = await ctx.env.BUCKET.list({ prefix, limit: 1000 });
    const checked = new Map<string, boolean>();
    const doomed: string[] = [];
    for (const object of listed.objects) {
      if (object.uploaded.getTime() > cutoff) continue;
      const version = object.key.slice(prefix.length).split('/')[0] ?? '';
      let known = checked.get(version);
      if (known === undefined) {
        known = await versionExists(ctx.env.DB, fork.templateId, version);
        checked.set(version, known);
      }
      if (!known && doomed.length < budget) doomed.push(object.key);
    }
    if (doomed.length === 0) continue;
    try {
      await ctx.env.BUCKET.delete(doomed);
      budget -= doomed.length;
      ctx.log.info('templates.fork_orphans_swept', {
        templateId: fork.templateId,
        count: doomed.length,
      });
    } catch (error) {
      ctx.log.warn('templates.fork_orphans_failed', { code: 'TEMPLATE_FORK_ORPHAN_GC', error });
    }
  }
}
