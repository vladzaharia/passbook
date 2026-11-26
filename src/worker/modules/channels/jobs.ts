import { anyDigitalOn, DIGITAL_CHANNELS, effectiveChannels } from '../../../shared/channels.ts';
import type { JobOf } from '../../jobs/types.ts';
import { bump } from '../../platform/counters.ts';
import { RateLimitedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { progressOf } from '../operations/progress.ts';
import { assertNewCodeAllowed, countNewCode } from '../passes/new-code.ts';
import { publishPass } from '../passes/publish.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { noticeHolder, rotateCode } from './replace.ts';
import { rotationOwed } from './repo-replace.ts';
import { loadPass } from './service.ts';
import { blockingWindow, openWindows } from './windows.ts';

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

const HOUR_S = 3600;
const MAX_DELAY_S = 12 * HOUR_S;

/**
 * Replaces one pass's code after a bulk "turn off and replace codes". It looks again at what the pass
 * has now: still off with a copy, and one digital channel on. While an event or session is open it
 * sends itself again for when that closes. Idempotent on the key.
 */
export async function handleReplaceCode(
  job: JobOf<'channel.replace_code'>,
  ctx: ServiceContext,
): Promise<void> {
  const progress = progressOf(ctx, job.operationId, job.attempt ?? 1);
  const codes = progress.step('codes');
  let outcome: Awaited<ReturnType<typeof replaceOne>>;
  try {
    outcome = await replaceOne(job, ctx);
  } catch (error) {
    // The New code limit (or any limit) will let it through later: the queue retries, and the row waits, not stalls.
    if (error instanceof RateLimitedError)
      await progress.waiting('codes', {
        until: ctx.clock.now() + HOUR_S * 1000,
        reason: 'Waiting for the limit',
      });
    throw error;
  }
  if (outcome !== 'done') {
    // It sent itself again for when its window closes: the operation waits on that, and is not stalled.
    await progress.waiting('codes', {
      until: ctx.clock.now() + outcome.waitSeconds * 1000,
      reason: 'Waiting for a scan window',
    });
    return;
  }
  // This pass is finished, whatever it came to: the last one ends the operation. A redelivered job counts once.
  if (
    job.operationId &&
    (await bump(ctx.env.DB, `op-tick:${job.operationId}:${job.passId}`, 0)) > 1
  )
    return;
  const counted = await codes.tick();
  if (counted && counted.total !== null && counted.done >= counted.total) {
    await codes.done();
    await progress.succeed({ href: null, ids: { replaced: String(counted.done) } });
  }
}

async function replaceOne(
  job: JobOf<'channel.replace_code'>,
  ctx: ServiceContext,
): Promise<'done' | { waitSeconds: number }> {
  const pass = await getPass(ctx.env.DB, job.passId);
  if (!pass || pass.removedAt !== null || pass.status !== 'active') return 'done';
  const { inputs, rows } = await loadPass(ctx, pass);
  const effective = effectiveChannels(inputs);
  const owed =
    anyDigitalOn(effective) &&
    DIGITAL_CHANNELS.some((c) => !effective[c].on && rows.copies.includes(c));
  if (!owed) return 'done';
  const now = ctx.clock.now();
  const open = blockingWindow(
    await openWindows(ctx, pass.orgId, pass.mode, pass.templateId, now, 1),
  );
  if (open) {
    const wait = open.closesAt === null ? HOUR_S : Math.ceil((open.closesAt - now) / 1000);
    ctx.log.info('channels.replace.window_wait', { passId: pass.id });
    const delaySeconds = Math.min(Math.max(wait, 60), MAX_DELAY_S);
    await ctx.env.JOBS.send(job, { delaySeconds });
    return { waitSeconds: delaySeconds };
  }
  const digitalOff = DIGITAL_CHANNELS.filter((c) => !effective[c].on && rows.copies.includes(c));
  const result = (await rotationOwed(ctx.env.DB, pass.orgId, pass.id, rows.retired, digitalOff))
    ? await rotateOnce(ctx, pass.id, job.key)
    : 'already';
  // 'already' covers a crash after the rotation committed: the mail job sends the notice once.
  if (result === 'rotated' || result === 'already') await noticeHolder(ctx, pass.id);
  else if (result === 'unsupported')
    ctx.log.info('channels.replace.unsupported', { passId: pass.id, orgId: pass.orgId });
  return 'done';
}

/** A bulk rotation counts against the pass's New code limit (the job retries when it is spent). */
async function rotateOnce(ctx: ServiceContext, passId: string, key: string) {
  await assertNewCodeAllowed(ctx, passId);
  const result = await rotateCode(ctx, passId, key);
  if (result === 'rotated') await countNewCode(ctx, passId);
  return result;
}
