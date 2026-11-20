import { AppError } from '../../platform/errors.ts';
import { aesCbcDecryptNoPad, aesCmac } from './aes-cmac.ts';
import { diversifyKey } from './diversify.ts';

/** Why a SUN read was refused. Stable codes; messages never carry keys, UIDs or MACs. */
export type SunFailure = 'SUN_MALFORMED' | 'SUN_PICC_INVALID' | 'SUN_MAC_INVALID';

export class SunError extends AppError {
  constructor(code: SunFailure) {
    super(code, 422, 'The tag read could not be verified.');
  }
}

export interface SunKeyset {
  /** SDM meta-read key (decrypts PICCData). 16 bytes. */
  metaKey: Uint8Array;
  /**
   * SDM file-read key (MAC). 16 bytes; the master key when `diversified`. A keyset whose tags carry their
   * own keys gives a lookup by UID instead, returning null for a tag it holds no key for: that tag is refused.
   */
  fileKey: Uint8Array | ((uid: string) => Promise<Uint8Array | null>);
  /** The file key is AN10922-diversified by the UID. Not with a lookup. */
  diversified: boolean;
}

export interface SunRead {
  /** 7 bytes, lowercase hex. */
  uid: string;
  counter: number;
}

export type SunResult = { ok: true; read: SunRead } | { ok: false; error: SunFailure };

const PICC_TAG = 0xc7;
const SV2_PREFIX = [0x3c, 0xc3, 0x00, 0x01, 0x00, 0x80];
const HEX = /^(?:[0-9a-fA-F]{2})+$/;

export function hexToBytes(hex: string): Uint8Array | null {
  if (!HEX.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** Compares without an early exit on the first differing byte. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/** The odd-indexed bytes (1, 3, ... 15) of a 16-byte CMAC: the 8-byte SDMMAC. */
const truncate = (cmac: Uint8Array): Uint8Array => cmac.filter((_, i) => i % 2 === 1);

/**
 * Verifies one tap's `p` (32 hex, encrypted PICCData) and `m` (16 hex, SDMMAC). Pure: it does not
 * consume the counter; the caller compares it with the stored one.
 */
export async function verifySun(keyset: SunKeyset, pHex: string, mHex: string): Promise<SunResult> {
  const p = hexToBytes(pHex);
  const m = hexToBytes(mHex);
  if (!p || !m || p.length !== 16 || m.length !== 8) return { ok: false, error: 'SUN_MALFORMED' };

  const picc = await aesCbcDecryptNoPad(keyset.metaKey, p);
  if (picc[0] !== PICC_TAG) return { ok: false, error: 'SUN_PICC_INVALID' };
  const uid = picc.slice(1, 8);
  const counter = picc.slice(8, 11);

  const uidHex = bytesToHex(uid);
  const base = typeof keyset.fileKey === 'function' ? await keyset.fileKey(uidHex) : keyset.fileKey;
  if (!base) return { ok: false, error: 'SUN_MAC_INVALID' };
  const fileKey = keyset.diversified ? await diversifyKey(base, uid) : base;
  const sv2 = new Uint8Array(16);
  sv2.set(SV2_PREFIX);
  sv2.set(uid, 6);
  sv2.set(counter, 13);
  const kses = await aesCmac(fileKey, sv2);
  const mac = truncate(await aesCmac(kses, new Uint8Array(0)));
  if (!constantTimeEqual(mac, m)) return { ok: false, error: 'SUN_MAC_INVALID' };

  const ctr =
    (counter[0] as number) | ((counter[1] as number) << 8) | ((counter[2] as number) << 16);
  return { ok: true, read: { uid: uidHex, counter: ctr } };
}
