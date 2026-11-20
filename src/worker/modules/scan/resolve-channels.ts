import type { Channel } from '../../../shared/contracts/channels.ts';
import type { ScanCodeInput } from '../../../shared/contracts/scan.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { doorChannels } from '../channels/door.ts';
import type { Candidate } from './repo-lookup.ts';

export type ChannelVerdict = { kind: 'off'; channel: Channel } | { kind: 'typed' } | null;

/**
 * The door's channel rules for a found pass (design-channels §3). A tag read needs Linked NFC. A code hit
 * is the code family: a scan code or barcode (or any non-typed read) is refused when every digital
 * channel is off. A typed number (a manual entry matching the lookup or serial alone, or a desk pick
 * by name) is only checked: on an all-off pass, and on a pass that had a New code after a retirement
 * or has a print, by any read method, so a plain Turn off never makes every scan a heads-up.
 */
export async function channelVerdict(
  ctx: ServiceContext,
  one: Candidate,
  input: ScanCodeInput,
  matchedBy: Candidate['matchedBy'],
): Promise<ChannelVerdict> {
  const nfc = input.method === 'nfc' && 'passId' in input;
  const picked = input.method === 'manual' && 'passId' in input;
  if ((!nfc && !picked && !matchedBy) || matchedBy === 'print') return null;
  // A camera or wedge read that matched the lookup value alone (the barcode is something else) is a typed number.
  const alone = matchedBy === 'lookup' && input.method !== 'manual';
  if (one.channelRules === false) return alone ? { kind: 'typed' } : null;
  const lookup = matchedBy === 'lookup' || matchedBy === 'serial';
  const typed = picked || (input.method === 'manual' && lookup);
  const door = await doorChannels(ctx, one.pass, lookup || picked);
  if (nfc) return door.nfcOn ? null : { kind: 'off', channel: 'nfc' };
  if (door.digitalOff) return typed ? { kind: 'typed' } : { kind: 'off', channel: door.named };
  return lookup && (alone || door.rotatedAfterRetire || door.printed) ? { kind: 'typed' } : null;
}

/**
 * Linked NFC off drops a pass from a tag's candidates, with one parallel read per pass. A lone pass stays: the door
 * answers it channel_off. So do all of them when none is left.
 */
export async function dropNfcOff(ctx: ServiceContext, all: Candidate[]): Promise<Candidate[]> {
  if (all.length < 2 || all.every((c) => c.channelRules === false)) return all;
  const states = await Promise.all(all.map((c) => doorChannels(ctx, c.pass)));
  const on = all.filter((_, i) => states[i]?.nfcOn);
  return on.length === 0 ? all : on;
}
