import { wbPath } from '@/shared/workbench.ts';

/**
 * What a Workbench link hands the Console (design §4.3, DM6): the operation and its inputs. The URL
 * names the operation and a nonce only; ids, queries and a body travel in `sessionStorage`, so a
 * body never rides a URL (L19). One helper for every launcher: Events, Passes, Home, the docs.
 */
export interface Prefill {
  op: string;
  path?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
}

/** `wb-prefill:<nonce>`: read once, then deleted. */
export const PREFILL_KEY = 'wb-prefill:';

/** Stores a prefill and returns its nonce; null when storage is blocked (the link then names only the operation). */
export function writePrefill(prefill: Prefill, nonce: string = crypto.randomUUID()): string | null {
  try {
    sessionStorage.setItem(`${PREFILL_KEY}${nonce}`, JSON.stringify(prefill));
    return nonce;
  } catch {
    // Storage is blocked: the Console still opens on the operation, without the inputs.
    return null;
  }
}

/** The prefill a nonce names, once: the entry is deleted as it is read. Null for an unknown or broken one. */
export function readPrefill(nonce: string): Prefill | null {
  const key = `${PREFILL_KEY}${nonce}`;
  try {
    const raw = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    if (raw === null) return null;
    const found = JSON.parse(raw) as Prefill;
    return typeof found === 'object' && found !== null && typeof found.op === 'string'
      ? found
      : null;
  } catch {
    return null;
  }
}

/** The Console link for a prefill, in this context's Test. */
export function consolePrefillPath(orgId: string, prefill: Prefill): string {
  const nonce = writePrefill(prefill);
  return wbPath(orgId, 'console', { query: { op: prefill.op, prefill: nonce ?? undefined } });
}
