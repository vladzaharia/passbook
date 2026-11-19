import type { Channel } from '../../../shared/contracts/channels.ts';
import type { ScanCodeInput } from '../../../shared/contracts/scan.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { doorChannels } from '../channels/door.ts';
import type { Candidate } from './repo-lookup.ts';

export type ChannelVerdict = { kind: 'off'; channel: Channel } | { kind: 'typed' } | null;

/**
 * The door's channel rules for a found pass (design-channels §3). A tag read needs Linked NFC. A code hit
 * is the code family: a scan code or barcode is refused when every digital channel is off; a typed number
 * (lookup or serial alone) is only checked, and only on a pass that had a New code after a retirement,
 * has a print or has no digital channel left, so a plain Turn off never makes every scan a heads-up.
 */
export async function channelVerdict(
  ctx: ServiceContext,
  one: Candidate,
  input: ScanCodeInput,
): Promise<ChannelVerdict> {
  const nfc = input.method === 'nfc' && 'passId' in input;
  if ((!nfc && !one.matchedBy) || one.matchedBy === 'print' || one.channelRules === false)
    return null;
  const door = await doorChannels(ctx, one.pass);
  if (nfc) return door.nfcOn ? null : { kind: 'off', channel: 'nfc' };
  const typed = one.matchedBy === 'lookup' || one.matchedBy === 'serial';
  if (door.digitalOff) return typed ? { kind: 'typed' } : { kind: 'off', channel: door.named };
  return typed && (door.rotatedAfterRetire || door.printed) ? { kind: 'typed' } : null;
}

/**
 * Linked NFC off drops a pass from a tag's candidates, in one round trip. A lone pass stays: the door
 * answers it channel_off. So do all of them when none is left.
 */
export async function dropNfcOff(ctx: ServiceContext, all: Candidate[]): Promise<Candidate[]> {
  if (all.length < 2 || all.every((c) => c.channelRules === false)) return all;
  const states = await Promise.all(all.map((c) => doorChannels(ctx, c.pass)));
  const on = all.filter((_, i) => states[i]?.nfcOn);
  return on.length === 0 ? all : on;
}
