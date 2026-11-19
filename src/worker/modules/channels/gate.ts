import { effectiveChannels } from '../../../shared/channels.ts';
import type { Channel, EffectiveChannels } from '../../../shared/contracts/channels.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import * as repo from './repo.ts';
import { loadPass } from './service.ts';

/** What the gate needs of a pass: the pass's own channel rows and its pinned template version. */
export interface GatePass {
  id: string;
  orgId: string;
  mode: Mode;
  templateId: string;
  templateVersion: string;
}

export interface HolderChannels {
  effective: EffectiveChannels;
  /** Paper is on and the template lets the holder print. */
  holderPrint: boolean;
}

/** The one reading of what a holder may be offered; SSR, portal, email and the API all use it. */
export async function holderChannels(ctx: ServiceContext, pass: GatePass): Promise<HolderChannels> {
  const { inputs, paperHolder } = await loadPass(ctx, pass);
  const effective = effectiveChannels(inputs);
  return { effective, holderPrint: effective.paper.on && paperHolder };
}

export async function channelOn(
  ctx: ServiceContext,
  pass: GatePass,
  channel: Channel,
): Promise<boolean> {
  return (await holderChannels(ctx, pass)).effective[channel].on;
}

/** Guards every holder artifact: a turned-off channel reads as not found. */
export async function channelGate(
  ctx: ServiceContext,
  pass: GatePass,
  channel: Channel,
): Promise<void> {
  if (!(await channelOn(ctx, pass, channel)))
    throw new NotFoundError('This is not available.', 'CHANNEL_OFF');
}

/** Copy evidence: the first time a copy is delivered in a channel. Insert-once, never updated. */
export async function recordCopy(
  ctx: ServiceContext,
  pass: GatePass,
  channel: Channel,
): Promise<void> {
  await repo.insertCopy(ctx.env.DB, pass, channel, ctx.clock.now());
}
