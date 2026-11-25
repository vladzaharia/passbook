import { aesCmac } from '../aes-cmac.ts';
import { constantTimeEqual } from '../sun.ts';
import { cbcEncrypt } from './aes.ts';
import { INS, native, type Response, SW, splitResponse } from './apdu.ts';
import { concat, macT, Ntag424Error, u16, ZERO16 } from './bytes.ts';
import type { Ev2Session } from './ev2.ts';

/** The counter a command used. Its response is checked against this plus one. */
export interface Sent {
  ctr: number;
}

const BLOCK = 16;
const EMPTY = new Uint8Array(0);

/** Zero-IV CBC of `label || TI || CmdCtr || 00..` under SesAuthENCKey: the IV of an encrypted command (A55A) or response (5AA5). */
export async function messageIv(
  s: Ev2Session,
  label: [number, number],
  ctr: number,
): Promise<Uint8Array> {
  return cbcEncrypt(
    s.encKey,
    ZERO16,
    concat(new Uint8Array(label), s.ti, u16(ctr), new Uint8Array(8)),
  );
}

/** ISO/IEC 9797-1 method 2 padding: 0x80 then zeros, always at least one byte. */
export function pad(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil((data.length + 1) / BLOCK) * BLOCK);
  out.set(data);
  out[data.length] = 0x80;
  return out;
}

/** A session is single use after a failure, and the 16-bit counter must never wrap (FFFFh ends the session on the tag). */
function usable(s: Ev2Session): void {
  if (s.dead) throw new Ntag424Error('NTAG_COMMAND_FAILED', 'The session has ended.');
  if (s.ctr >= 0xffff)
    throw new Ntag424Error('NTAG_COMMAND_FAILED', 'The command counter is spent.');
}

const tag = async (s: Ev2Session, ins: number, ctr: number, rest: Uint8Array) =>
  macT(await aesCmac(s.macKey, concat(new Uint8Array([ins]), u16(ctr), s.ti, rest)));

/** CommMode.MAC: header and data travel plain, followed by MACt over `Cmd || CmdCtr || TI || header || data`. */
export async function macCommand(
  s: Ev2Session,
  ins: number,
  header: Uint8Array,
  data: Uint8Array = EMPTY,
): Promise<{ apdu: Uint8Array; sent: Sent }> {
  usable(s);
  const sent = { ctr: s.ctr };
  const body = concat(header, data);
  const mac = await tag(s, ins, sent.ctr, body);
  s.ctr += 1;
  return { apdu: native(ins, concat(body, mac)), sent };
}

/** CommMode.Full: data is padded and CBC-encrypted under the command IV; the MAC covers the header and the cryptogram. */
export async function fullCommand(
  s: Ev2Session,
  ins: number,
  header: Uint8Array,
  data: Uint8Array,
): Promise<{ apdu: Uint8Array; sent: Sent }> {
  usable(s);
  const sent = { ctr: s.ctr };
  const enc = await cbcEncrypt(s.encKey, await messageIv(s, [0xa5, 0x5a], sent.ctr), pad(data));
  const mac = await tag(s, ins, sent.ctr, concat(header, enc));
  s.ctr += 1;
  return { apdu: native(ins, concat(header, enc, mac)), sent };
}

/**
 * CommMode.Plain in an authenticated session: no MAC and no encryption, but the counter still moves (the tag
 * counts the command so a later MAC or cryptogram can't skip one). The answer is a bare 9100 or data.
 */
export async function plainCommand(
  s: Ev2Session,
  ins: number,
  header: Uint8Array,
  data: Uint8Array = EMPTY,
): Promise<{ apdu: Uint8Array; sent: Sent }> {
  usable(s);
  const sent = { ctr: s.ctr };
  s.ctr += 1;
  return { apdu: native(ins, concat(header, data)), sent };
}

/**
 * A response in CommMode.MAC or Full without response data: status 9100 and MACt over
 * `00 || CmdCtr+1 || TI || data`. Any other status, or a MAC that does not match, is refused.
 */
export async function checkResponse(
  s: Ev2Session,
  sent: Sent,
  raw: Uint8Array,
): Promise<Uint8Array> {
  const fail = (code: 'NTAG_COMMAND_FAILED' | 'NTAG_MAC_INVALID', message: string) => {
    s.dead = true;
    return new Ntag424Error(code, message);
  };
  const r = splitResponse(raw);
  if (r.sw !== SW.ok)
    throw fail('NTAG_COMMAND_FAILED', `The tag refused the command (${r.sw.toString(16)}).`);
  if (r.data.length < 8) throw fail('NTAG_MAC_INVALID', 'The tag answer has no MAC.');
  const data = r.data.slice(0, r.data.length - 8);
  const mac = r.data.slice(r.data.length - 8);
  const want = await tag(s, 0x00, sent.ctr + 1, data);
  if (!constantTimeEqual(mac, want))
    throw fail('NTAG_MAC_INVALID', 'The tag answer failed its MAC.');
  return data;
}

/** The answer to a command that ends the session (ChangeKey on the key in use): 9100 and nothing else. */
export function checkBare(s: Ev2Session, raw: Uint8Array): Response {
  const r = splitResponse(raw);
  if (r.sw !== SW.ok || r.data.length !== 0) {
    s.dead = true;
    throw new Ntag424Error('NTAG_COMMAND_FAILED', 'The tag refused the command.');
  }
  return r;
}

export const getKeyVersion = (s: Ev2Session, keyNo: number) =>
  macCommand(s, INS.getKeyVersion, new Uint8Array([keyNo]));

export const getFileSettings = (s: Ev2Session, fileNo: number) =>
  macCommand(s, INS.getFileSettings, new Uint8Array([fileNo]));
