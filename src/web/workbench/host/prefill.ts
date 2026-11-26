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

/** `wb-prefill:<nonce>`: deleted from storage on its first read. */
export const PREFILL_KEY = 'wb-prefill:';

/** A nonce read once stays readable for this page: a remount must not lose it. */
const seen = new Map<string, Prefill | null>();

/** Stores a prefill and returns its nonce. Blocked storage keeps it in memory for this page. */
export function writePrefill(prefill: Prefill, nonce: string = crypto.randomUUID()): string {
  try {
    sessionStorage.setItem(`${PREFILL_KEY}${nonce}`, JSON.stringify(prefill));
  } catch {
    seen.set(nonce, prefill);
  }
  return nonce;
}

/** The prefill a nonce names. Null for an unknown or broken one. */
export function readPrefill(nonce: string): Prefill | null {
  if (seen.has(nonce)) return seen.get(nonce) ?? null;
  let found: Prefill | null = null;
  try {
    const key = `${PREFILL_KEY}${nonce}`;
    const raw = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    const parsed = raw === null ? null : (JSON.parse(raw) as Prefill);
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.op === 'string')
      found = parsed;
  } catch {
    // Blocked storage or a value that is not ours: no prefill.
  }
  seen.set(nonce, found);
  return found;
}

/** The Console link for a prefill, in this context's Test. */
export function consolePrefillPath(orgId: string, prefill: Prefill): string {
  return wbPath(orgId, 'console', { query: { op: prefill.op, prefill: writePrefill(prefill) } });
}
