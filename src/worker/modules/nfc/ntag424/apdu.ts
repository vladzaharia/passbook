import { concat, Ntag424Error } from './bytes.ts';

/** The NDEF application's ISO DF name and the files commands name (native file numbers and ISO ids). */
export const NDEF_AID = new Uint8Array([0xd2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01]);
export const FILE_NDEF = 0x02;
export const ISO_FILE_NDEF = 0xe104;

export const INS = {
  authFirst: 0x71,
  additional: 0xaf,
  getVersion: 0x60,
  getKeyVersion: 0x64,
  getFileSettings: 0xf5,
  changeFileSettings: 0x5f,
  changeKey: 0xc4,
  writeData: 0x8d,
  readSig: 0x3c,
} as const;

/** Native status words, SW1 0x91. */
export const SW = { ok: 0x9100, more: 0x91af, authError: 0x91ae, integrity: 0x911e } as const;

/** A native command: `90 INS 00 00 Lc body 00`, or without Lc and body when `body` is empty. */
export function native(ins: number, body: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (body.length > 255) throw new RangeError('one APDU carries 255 data bytes');
  const head = [0x90, ins, 0x00, 0x00];
  if (body.length === 0) return new Uint8Array([...head, 0x00]);
  return concat(new Uint8Array([...head, body.length]), body, new Uint8Array([0x00]));
}

export const selectNdefApp = (): Uint8Array =>
  concat(new Uint8Array([0x00, 0xa4, 0x04, 0x0c, NDEF_AID.length]), NDEF_AID, new Uint8Array([0]));

export const selectFile = (id: number): Uint8Array =>
  new Uint8Array([0x00, 0xa4, 0x00, 0x0c, 0x02, id >> 8, id & 0xff, 0x00]);

/** ISO ReadBinary with Le 0: up to 256 bytes from `offset`. */
export const readBinary = (offset = 0): Uint8Array =>
  new Uint8Array([0x00, 0xb0, (offset >> 8) & 0x7f, offset & 0xff, 0x00]);

export interface Response {
  /** SW1 << 8 | SW2. */
  sw: number;
  data: Uint8Array;
}

export function splitResponse(raw: Uint8Array): Response {
  if (raw.length < 2) throw new Ntag424Error('NTAG_BAD_RESPONSE', 'The tag answer is too short.');
  const n = raw.length;
  return { sw: ((raw[n - 2] as number) << 8) | (raw[n - 1] as number), data: raw.slice(0, n - 2) };
}

export function expectSw(r: Response, ...allowed: number[]): Response {
  if (!allowed.includes(r.sw))
    throw new Ntag424Error(
      r.sw === SW.authError ? 'NTAG_AUTH_FAILED' : 'NTAG_COMMAND_FAILED',
      `The tag refused the command (${r.sw.toString(16)}).`,
    );
  return r;
}

export interface Version {
  vendor: number;
  type: number;
  subtype: number;
  storage: number;
  uid: Uint8Array;
}

/** The three GetVersion parts joined: hardware (7), software (7), production data (14, with the 7-byte UID). */
export function parseVersion(hw: Uint8Array, sw: Uint8Array, prod: Uint8Array): Version {
  if (hw.length !== 7 || sw.length !== 7 || prod.length < 7)
    throw new Ntag424Error('NTAG_BAD_RESPONSE', 'The tag version is malformed.');
  return {
    vendor: hw[0] as number,
    type: hw[1] as number,
    subtype: hw[2] as number,
    storage: hw[5] as number,
    uid: prod.slice(0, 7),
  };
}

/** Vendor NXP (04), type NTAG (04), subtype 424 DNA (02 or 08), 256 to 512 B storage (11). */
export const isNtag424 = (v: Version): boolean =>
  v.vendor === 0x04 &&
  v.type === 0x04 &&
  (v.subtype === 0x08 || v.subtype === 0x02) &&
  v.storage === 0x11;
