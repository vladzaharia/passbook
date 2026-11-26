/** `sessionStorage` key prefix of a prefill handed over by nonce (design §4.3): a body never rides in a URL. */
export const PREFILL_KEY = 'wb-prefill:';

export interface Prefill {
  op: string;
  path?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
}

/** Stores the prefill and returns the nonce for `?prefill=`. Null when storage is blocked. */
export function writePrefill(prefill: Prefill, nonce: string = crypto.randomUUID()): string | null {
  try {
    sessionStorage.setItem(`${PREFILL_KEY}${nonce}`, JSON.stringify(prefill));
    return nonce;
  } catch {
    // Storage is blocked: the caller opens the operation on its own sample.
    return null;
  }
}

/** Reads a prefill once: it is deleted on read, so a reload opens the operation's own sample. */
export function readPrefill(nonce: string): Prefill | null {
  const key = `${PREFILL_KEY}${nonce}`;
  try {
    const raw = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    return raw ? (JSON.parse(raw) as Prefill) : null;
  } catch {
    // Blocked storage or a value that is not ours: no prefill.
    return null;
  }
}
