import type { Mode } from '../../../shared/contracts/common.ts';
import { derivedHmacKey } from '../../platform/crypto.ts';
import { toBase32, toHex } from '../../platform/ids.ts';

const encoder = new TextEncoder();
/** `P` and 26 base32 characters (128 bits). A scan code has no prefix, so the two never collide. */
const PRINT_CODE = /^P[A-Z2-7]{26}$/;

const mac = async (env: object, label: string, parts: string[]): Promise<Uint8Array> => {
  const key = await derivedHmacKey(env, label);
  return new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(JSON.stringify(parts)) as BufferSource),
  );
};

/**
 * The code printed on a ticket. Derived from the print id under the platform key, so nothing stores it
 * and the print page can show it again; only a holder of the key can compute it.
 */
export async function printCodeOf(
  env: object,
  print: { id: string; passId: string; orgId: string; mode: Mode },
): Promise<string> {
  const bytes = await mac(env, 'pass-print-code-v1', [
    print.orgId,
    print.mode,
    print.passId,
    print.id,
  ]);
  return `P${toBase32(bytes.slice(0, 16))}`;
}

/** The shape a typed or scanned string must have to be a print code; null when it is not one. */
function printCodeKeyOf(clean: string): string | null {
  const key = clean.toUpperCase().replace(/[\s-]/g, '');
  return PRINT_CODE.test(key) ? key : null;
}

/** The keyed reference the door looks a code up by (`print_code_hash`); null for a non-print string. */
export async function printCodeRef(
  env: object,
  orgId: string,
  mode: Mode,
  clean: string,
): Promise<string | null> {
  const code = printCodeKeyOf(clean);
  return code === null ? null : toHex(await mac(env, 'pass-print-ref-v1', [orgId, mode, code]));
}

/** First 128 bits of SHA-256 of the code: the offline roster's hash of a scan code (`rosterHash`). */
export async function printRosterHash(code: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(code.trim()));
  return toHex(new Uint8Array(digest).slice(0, 16));
}
