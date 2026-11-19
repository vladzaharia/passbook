import type { JobOf } from '../../jobs/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { publishPass } from '../passes/publish.ts';
import { getPass } from '../passes/repo-read-pass.ts';

/**
 * Republishes (force) a pass whose Apple state flipped, so the version moves, the push goes out
 * and the device fetches the voided or live copy (N4). Idempotent: it acts only while the Apple row
 * is newer than the pass, so a duplicate or a retry after a lost message does nothing extra. A
 * failure throws and the queue retries.
 */
export async function handleAppleBump(
  job: JobOf<'channel.apple_bump'>,
  ctx: ServiceContext,
): Promise<void> {
  const pass = await getPass(ctx.env.DB, job.passId);
  if (!pass || pass.removedAt !== null || pass.status !== 'active') return;
  // A publish after the change committed moved the version past the message's: nothing to do.
  if (pass.version > job.version) return;
  await publishPass(ctx, {
    passId: pass.id,
    cause: 'resign',
    actor: { type: 'system', id: `channel.apple_bump:${pass.id}:${job.version}` },
    force: true,
    notify: false,
  });
}
