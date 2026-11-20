import { DIGITAL_CHANNELS, effectiveChannels } from '../../../shared/channels.ts';
import type { Channel, EffectiveChannels } from '../../../shared/contracts/channels.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { hasPrint, rotatedSince } from './repo.ts';
import { loadPass } from './service.ts';

export interface DoorChannels {
  /** The pass's linked NFC state. */
  nfcOn: boolean;
  /** No digital channel is on: its code family refuses. */
  digitalOff: boolean;
  /** The digital channel a refusal names: the latest retired, else the first. */
  named: Channel;
  /** A New code was issued after a digital channel was retired: typed numbers are checked. */
  rotatedAfterRetire: boolean;
  /** The pass has an active or past print (read only for a typed number). */
  printed: boolean;
}

interface PassRef {
  id: string;
  orgId: string;
  mode: Mode;
  templateId: string;
  templateVersion: string;
}

/**
 * What a pass already has working: its channels with the plan set aside. A downgrade only stops new copies
 * (a print, a tag bind, a wallet offer); a printed ticket, a bound tag or a copy a holder has keeps
 * working at the door and on its page ("pause, never delete").
 */
export async function existingChannels(
  ctx: ServiceContext,
  pass: PassRef,
): Promise<EffectiveChannels> {
  const { inputs } = await loadPass(ctx, pass);
  return effectiveChannels({ ...inputs, entitlement: {} });
}

/** What the door needs of a pass's channels: one read of the pass's channels as they already work. */
/** `typed` also reads the rotation and print facts a typed number is checked by. */
export async function doorChannels(
  ctx: ServiceContext,
  pass: PassRef,
  typed = false,
): Promise<DoorChannels> {
  const effective = await existingChannels(ctx, pass);
  const digital = DIGITAL_CHANNELS.map((channel) => ({
    channel,
    retiredAt: effective[channel].retiredAt,
    on: effective[channel].on,
  }));
  const retired = digital.flatMap((d) => (d.retiredAt === undefined ? [] : [d.retiredAt]));
  const latest = digital
    .filter((d) => d.retiredAt !== undefined)
    .sort((a, b) => (b.retiredAt ?? 0) - (a.retiredAt ?? 0))[0];
  const [rotated, printed] = typed
    ? await Promise.all([
        retired.length > 0 && rotatedSince(ctx.env.DB, pass.orgId, pass.id, Math.min(...retired)),
        hasPrint(ctx.env.DB, pass.orgId, pass.id),
      ])
    : [false, false];
  return {
    nfcOn: effective.nfc.on,
    digitalOff: digital.every((d) => !d.on),
    named: (latest ?? digital[0])?.channel ?? 'mobile',
    rotatedAfterRetire: rotated,
    printed,
  };
}
