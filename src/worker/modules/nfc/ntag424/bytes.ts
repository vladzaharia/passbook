/** Why an NTAG 424 DNA exchange was refused. Messages never carry keys, UIDs or APDUs. */
export type Ntag424Failure =
  | 'NTAG_AUTH_FAILED'
  | 'NTAG_MAC_INVALID'
  | 'NTAG_BAD_RESPONSE'
  | 'NTAG_COMMAND_FAILED'
  | 'NTAG_UNSUPPORTED';

/** Never reaches HTTP: the programming service maps it to a `TAG_PROGRAM_*` code. */
export class Ntag424Error extends Error {
  readonly code: Ntag424Failure;
  constructor(code: Ntag424Failure, message: string) {
    super(message);
    this.name = 'Ntag424Error';
    this.code = code;
  }
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function xor(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length !== b.length) throw new RangeError('xor needs equal lengths');
  return a.map((v, i) => v ^ (b[i] as number));
}

/** 3 bytes, least significant first, as offsets and lengths travel in native commands. */
export const u24 = (n: number): Uint8Array =>
  new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]);

/** 2 bytes, least significant first: the command counter. */
export const u16 = (n: number): Uint8Array => new Uint8Array([n & 0xff, (n >> 8) & 0xff]);

/** The even-numbered bytes (1, 3, ... 15) of a CMAC: the 8-byte MACt of secure messaging. */
export const macT = (cmac: Uint8Array): Uint8Array => cmac.filter((_, i) => i % 2 === 1);

export const ZERO16 = new Uint8Array(16);
