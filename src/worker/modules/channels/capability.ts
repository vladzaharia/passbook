import { channelTransition, effectiveChannels } from '../../../shared/channels.ts';
import { CHANNELS, type Channel } from '../../../shared/contracts/channels.ts';
import type { JobOf } from '../../jobs/types.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordPassEvents } from '../events/record.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { capabilityOf } from './repo.ts';
import { channelRevisions } from './repo-apply.ts';
import { type CapabilityRow, writeCapabilityChange } from './repo-capability-write.ts';
import { capabilityReasons, loadPass } from './service.ts';

const WALLETS = ['google', 'samsung'] as const;

/**
 * Called after a publish that moved a pass to another template version. Queues the reconcile only when
 * the wallets the two versions can serve differ; org and platform blocks and plain releases never
 * come this way (a kill switch never retires). A failed send is logged: the pass keeps serving.
 */
export async function onChannelsMaybeChanged(
  ctx: ServiceContext,
  pass: { id: string; templateId: string; templateVersion: string },
  previousVersion: string | null | undefined,
): Promise<void> {
  if (!previousVersion || previousVersion === pass.templateVersion) return;
  try {
    const [was, now] = await Promise.all([
      capabilityOf(ctx.env.DB, pass.templateId, previousVersion),
      capabilityOf(ctx.env.DB, pass.templateId, pass.templateVersion),
    ]);
    if (WALLETS.every((w) => was[w] === now[w])) return;
    await ctx.env.JOBS.send({ kind: 'channel.capability', passId: pass.id, previousVersion });
  } catch (error) {
    ctx.log.error('channels.capability_queue_failed', {
      passId: pass.id,
      code: 'CHANNEL_CAPABILITY_QUEUE',
      error,
    });
  }
}

/** The per-pass transition with before taken from the previous version's capability. */
export async function handleCapabilityChange(
  job: JobOf<'channel.capability'>,
  ctx: ServiceContext,
): Promise<void> {
  const pass = await getPass(ctx.env.DB, job.passId);
  if (!pass || pass.removedAt !== null) return;
  const { inputs, rows } = await loadPass(ctx, pass);
  const previous = await capabilityOf(ctx.env.DB, pass.templateId, job.previousVersion);
  const before = effectiveChannels({ ...inputs, capability: capabilityReasons(previous) });
  const after = effectiveChannels(inputs);
  const actions = channelTransition(before, after, {
    copies: new Set(rows.copies),
    retired: new Set(Object.keys(rows.retired) as Channel[]),
  });
  const now = ctx.clock.now();
  const writes = actions.flatMap<Omit<CapabilityRow, 'seen'>>((a) => {
    if (a.kind === 'retire')
      return [{ channel: a.channel, retiredAt: now, retiredCause: 'template' as const }];
    if (a.kind === 'restore') return [{ channel: a.channel, retiredAt: null, retiredCause: null }];
    return [];
  });
  // Only a flip the marker records: a repeat finds the channel already retired.
  const flips = CHANNELS.filter(
    (c) => before[c].on !== after[c].on && writes.some((w) => w.channel === c),
  ).map((channel) => ({
    channel,
    from: before[channel].on ? 'on' : 'off',
    to: after[channel].on ? 'on' : 'off',
    source: after[channel].source,
  }));
  if (writes.length === 0) return;
  const seen = (await channelRevisions(ctx.env.DB, [pass.id])).get(pass.id) ?? {};
  try {
    await writeCapabilityChange(
      ctx,
      pass,
      writes.map((w) => ({ ...w, seen: seen[w.channel] })),
      flips,
    );
  } catch (error) {
    // A pass-level write moved the row meanwhile and applied its own transition.
    if (error instanceof AppError && error.code === 'CHANNEL_APPLY_STALE') {
      ctx.log.info('channels.capability_stale', { passId: pass.id });
      return;
    }
    throw error;
  }
  await recordPassEvents(
    ctx,
    flips.map((data) => ({
      orgId: pass.orgId,
      passId: pass.id,
      mode: pass.mode,
      kind: 'pass.channels_changed' as const,
      actor: { type: 'system', id: 'channel-capability' },
      data,
    })),
  );
}
