import { DIGITAL_CHANNELS, effectiveChannels } from '../../../shared/channels.ts';
import type { Channel } from '../../../shared/contracts/channels.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { rotatedSince } from './repo.ts';
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
}

interface PassRef {
  id: string;
  orgId: string;
  mode: Mode;
  templateId: string;
  templateVersion: string;
}

/** What the door needs of a pass's channels: one read of the pass's effective state. */
export async function doorChannels(ctx: ServiceContext, pass: PassRef): Promise<DoorChannels> {
  const { inputs } = await loadPass(ctx, pass);
  const effective = effectiveChannels(inputs);
  // Tags work today on templates without scan.tags: only an explicit off (policy, pass, org) refuses.
  const nfcOn = effectiveChannels({ ...inputs, scanTags: true }).nfc.on;
  const digital = DIGITAL_CHANNELS.map((channel) => ({
    channel,
    retiredAt: effective[channel].retiredAt,
    on: effective[channel].on,
  }));
  const retired = digital.flatMap((d) => (d.retiredAt === undefined ? [] : [d.retiredAt]));
  const latest = digital
    .filter((d) => d.retiredAt !== undefined)
    .sort((a, b) => (b.retiredAt ?? 0) - (a.retiredAt ?? 0))[0];
  const rotated =
    retired.length > 0 && (await rotatedSince(ctx.env.DB, pass.id, Math.min(...retired)));
  return {
    nfcOn,
    digitalOff: digital.every((d) => !d.on),
    named: (latest ?? digital[0])?.channel ?? 'mobile',
    rotatedAfterRetire: rotated,
  };
}
