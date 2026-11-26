import type { Json } from '../../developers/model/types.ts';

/**
 * What one tool hands the Console (design §4.3): a request body never rides in a URL, so the sender
 * writes it here and links `?op=&prefill=<nonce>`. The Console reads it once.
 */
export interface PrefillPayload {
  op: string;
  path?: Record<string, string>;
  query?: Record<string, string>;
  body?: Json;
}

const PREFIX = 'wb-prefill:';
/** A nonce read once stays readable for this page: a remount must not lose it. */
const read = new Map<string, PrefillPayload | null>();

/** Stores `payload` for one read and returns the nonce to link with. Blocked storage keeps it in memory. */
export function writePrefill(payload: PrefillPayload): string {
  const nonce = crypto.randomUUID().slice(0, 8);
  try {
    sessionStorage.setItem(`${PREFIX}${nonce}`, JSON.stringify(payload));
  } catch {
    // Blocked storage: this page still has it.
    read.set(nonce, payload);
  }
  return nonce;
}

/** The payload for `nonce`, deleted from storage on the first read. Null when there is none. */
export function readPrefill(nonce: string): PrefillPayload | null {
  if (read.has(nonce)) return read.get(nonce) ?? null;
  let found: PrefillPayload | null = null;
  try {
    const raw = sessionStorage.getItem(`${PREFIX}${nonce}`);
    sessionStorage.removeItem(`${PREFIX}${nonce}`);
    if (raw) found = JSON.parse(raw) as PrefillPayload;
  } catch {
    // Not there, or not JSON: nothing to fill in.
  }
  read.set(nonce, found);
  return found;
}
