import { wbPath } from '@/shared/workbench.ts';

/** The Console reads and deletes this key once: `wb-prefill:<nonce>` (design §4.3). */
export const PREFILL_KEY = 'wb-prefill:';

/** What a prefill holds: path ids and query values. Never a body (L19). */
export interface ConsolePrefill {
  path?: Record<string, string>;
  query?: Record<string, string>;
}

/**
 * The Console on an operation with ids filled in. Ids travel by a `sessionStorage` nonce, so the URL
 * names the operation and the nonce only; it never auto-runs.
 */
export function consoleLink(orgId: string, op: string, prefill: ConsolePrefill): string {
  const nonce = crypto.randomUUID().slice(0, 8);
  try {
    sessionStorage.setItem(`${PREFILL_KEY}${nonce}`, JSON.stringify(prefill));
  } catch {
    // Storage is blocked: the Console opens on the operation without the ids.
    return wbPath(orgId, 'console', { query: { op } });
  }
  return wbPath(orgId, 'console', { query: { op, prefill: nonce } });
}

/** An event in the Console: `GET /events/{id}`. */
export const eventInConsole = (orgId: string, eventId: string): string =>
  consoleLink(orgId, 'events.getEventsById', { path: { id: eventId } });
