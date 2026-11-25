import { INS } from './apdu.ts';
import { concat, Ntag424Error, xor } from './bytes.ts';
import { crc32Nk } from './crc32.ts';
import type { Ev2Session } from './ev2.ts';
import { fullCommand, type Sent } from './secure-messaging.ts';

export interface ChangeKeyInput {
  keyNo: number;
  newKey: Uint8Array;
  /** 0x01..0xFF; 0x00 is the factory version, which is what lets a recovery tell old keys from new. */
  version: number;
  /** The key now in the slot. Required unless `keyNo` is the key the session authenticated with. */
  oldKey?: Uint8Array;
}

/**
 * ChangeKey. The authenticated key itself is sent as `new || version` and ends the session (the answer is a
 * bare 9100); any other key is sent as `(old xor new) || version || CRC32(new)`, so the tag can tell the old
 * key was right. Always change key 0 last.
 */
export async function changeKey(
  s: Ev2Session,
  input: ChangeKeyInput,
): Promise<{ apdu: Uint8Array; sent: Sent; endsSession: boolean }> {
  const { keyNo, newKey, version, oldKey } = input;
  if (newKey.length !== 16) throw new RangeError('AES-128 key must be 16 bytes');
  if (version < 1 || version > 0xff) throw new RangeError('key version must be 1..255');
  const own = keyNo === s.keyNo;
  if (!own && oldKey?.length !== 16)
    throw new Ntag424Error('NTAG_UNSUPPORTED', 'Changing another key needs its current value.');
  const data = own
    ? concat(newKey, new Uint8Array([version]))
    : concat(xor(newKey, oldKey as Uint8Array), new Uint8Array([version]), crc32Nk(newKey));
  const sent = await fullCommand(s, INS.changeKey, new Uint8Array([keyNo]), data);
  return { ...sent, endsSession: own };
}
