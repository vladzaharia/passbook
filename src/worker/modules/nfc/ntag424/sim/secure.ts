import { aesCmac } from '../../aes-cmac.ts';
import { constantTimeEqual } from '../../sun.ts';
import { cbcDecrypt } from '../aes.ts';
import { concat, macT, u16 } from '../bytes.ts';
import type { Ev2Session } from '../ev2.ts';
import { messageIv } from '../secure-messaging.ts';

const SW_INTEGRITY = 0x911e;
const SW_LENGTH = 0x917e;

export type Opened =
  | { ok: true; header: Uint8Array; data: Uint8Array }
  | { ok: false; sw: number; drop: boolean };

/** Removes `80 00..` padding; null when the padding is not that. */
export function unpad(plain: Uint8Array): Uint8Array | null {
  let i = plain.length - 1;
  while (i >= 0 && plain[i] === 0) i--;
  return i >= 0 && plain[i] === 0x80 ? plain.slice(0, i) : null;
}

/**
 * The tag's side of a secure command: checks the MAC over `ins || CmdCtr || TI || header || data` and, in
 * Full mode, decrypts the data with the command IV. A bad MAC ends the session. Advances the counter.
 */
export async function openCommand(
  s: Ev2Session,
  ins: number,
  body: Uint8Array,
  headerLength: number,
  full: boolean,
): Promise<Opened> {
  if (body.length < headerLength + 8) return { ok: false, sw: SW_LENGTH, drop: false };
  const covered = body.slice(0, body.length - 8);
  const mac = body.slice(body.length - 8);
  const want = macT(
    await aesCmac(s.macKey, concat(new Uint8Array([ins]), u16(s.ctr), s.ti, covered)),
  );
  if (!constantTimeEqual(mac, want)) return { ok: false, sw: SW_INTEGRITY, drop: true };
  const header = covered.slice(0, headerLength);
  const rest = covered.slice(headerLength);
  let data: Uint8Array = rest;
  if (full) {
    if (rest.length === 0 || rest.length % 16 !== 0)
      return { ok: false, sw: SW_LENGTH, drop: false };
    data = await cbcDecrypt(s.encKey, await messageIv(s, [0xa5, 0x5a], s.ctr), rest);
  }
  s.ctr += 1;
  return { ok: true, header, data };
}

/** `data || MACt` over `00 || CmdCtr+1 || TI || data`, then 9100. */
export async function sealResponse(s: Ev2Session, data: Uint8Array): Promise<Uint8Array> {
  const mac = macT(await aesCmac(s.macKey, concat(new Uint8Array([0x00]), u16(s.ctr), s.ti, data)));
  return concat(data, mac, new Uint8Array([0x91, 0x00]));
}
