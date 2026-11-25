import { Ntag424Error } from './bytes.ts';
import { PLAIN_WRITE_MAX } from './file-settings.ts';

export interface SunTemplate {
  /** The NDEF file as written: 2-byte NLEN, then one short URI record carrying the placeholders. */
  file: Uint8Array;
  /** Offsets from the start of file 02 (NLEN included): the 32 PICCData digits and the 16 MAC digits. */
  piccOffset: number;
  macOffset: number;
}

const HTTPS = 'https://';
export const P_DIGITS = 32;
export const M_DIGITS = 16;

/**
 * `https://{host}/t/{slug}?p=<32 zeros>&m=<16 zeros>` as one URI record (prefix code 04 = `https://`), the shape
 * `parseSunUrl` reads. The tag overwrites the zeros on every read.
 */
export function sunTemplate(host: string, slug: string): SunTemplate {
  const rest = `${host}/t/${slug}?p=`;
  const tail = `${'0'.repeat(P_DIGITS)}&m=`;
  const text = `${rest}${tail}${'0'.repeat(M_DIGITS)}`;
  const payload = new Uint8Array([0x04, ...new TextEncoder().encode(text)]);
  if (payload.length > 0xff || text.includes(HTTPS) || !/^[\x21-\x7e]+$/.test(text))
    throw new Ntag424Error('NTAG_UNSUPPORTED', 'The tag URL does not fit one short record.');
  const record = new Uint8Array([0xd1, 0x01, payload.length, 0x55, ...payload]);
  const file = new Uint8Array(2 + record.length);
  file[0] = record.length >> 8;
  file[1] = record.length & 0xff;
  file.set(record, 2);
  if (file.length > PLAIN_WRITE_MAX)
    throw new Ntag424Error('NTAG_UNSUPPORTED', 'The tag URL does not fit one write.');
  // Record header is 4 bytes, then the prefix code, then the text.
  const base = 2 + 4 + 1;
  return { file, piccOffset: base + rest.length, macOffset: base + rest.length + tail.length };
}
