import { anyDigitalOn, DIGITAL_CHANNELS, effectiveChannels } from '../../../shared/channels.ts';
import type { JobOf } from '../../jobs/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { publishPass } from '../passes/publish.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { noticeHolder, rotateCode } from './replace.ts';
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
  const pass = await getPass(ctx.env.DB, job.passId);
  if (!pass || pass.removedAt !== null || pass.status !== 'active') return;
  const { inputs, rows } = await loadPass(ctx, pass);
  const effective = effectiveChannels(inputs);
  const owed =
    anyDigitalOn(effective) &&
    DIGITAL_CHANNELS.some((c) => !effective[c].on && rows.copies.includes(c));
  if (!owed) return;
  const now = ctx.clock.now();
  const open = blockingWindow(
    await openWindows(ctx, pass.orgId, pass.mode, pass.templateId, now, 1),
  );
  if (open) {
    const wait = open.closesAt === null ? HOUR_S : Math.ceil((open.closesAt - now) / 1000);
    ctx.log.info('channels.replace.window_wait', { passId: pass.id });
    await ctx.env.JOBS.send(job, { delaySeconds: Math.min(Math.max(wait, 60), MAX_DELAY_S) });
    return;
  }
  const result = await rotateCode(ctx, pass.id, job.key);
  if (result === 'rotated') await noticeHolder(ctx, pass.id);
  else if (result === 'unsupported')
    ctx.log.info('channels.replace.unsupported', { passId: pass.id, orgId: pass.orgId });
}
