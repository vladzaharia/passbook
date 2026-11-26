import type { Json } from './types.ts';

/**
 * What another tool hands the Console (design §4.3): a request body never rides in a URL, so the
 * sender stores it under a nonce and links `?op=&prefill=<nonce>`. The Console reads it once.
 */
export interface Handoff {
  body?: Json;
  query?: Record<string, string>;
  /** A line the Console shows over the form: where this request came from. */
  note?: string;
}

const PREFIX = 'wb-prefill:';
/** A nonce read once stays readable for this page: a remount (strict mode, a re-render) must not lose it. */
const read = new Map<string, Handoff | null>();

/** Stores `handoff` for one read and returns the nonce to link with. Storage that is blocked keeps it in memory. */
export function stashHandoff(handoff: Handoff): string {
  const nonce = crypto.randomUUID().slice(0, 8);
  try {
    sessionStorage.setItem(`${PREFIX}${nonce}`, JSON.stringify(handoff));
  } catch {
    // Blocked storage: this page still has it.
    read.set(nonce, handoff);
  }
  return nonce;
}

/** The handoff for `nonce`, deleted from storage on the first read. Null when there is none. */
export function takeHandoff(nonce: string): Handoff | null {
  if (read.has(nonce)) return read.get(nonce) ?? null;
  let found: Handoff | null = null;
  try {
    const raw = sessionStorage.getItem(`${PREFIX}${nonce}`);
    sessionStorage.removeItem(`${PREFIX}${nonce}`);
    if (raw) found = JSON.parse(raw) as Handoff;
  } catch {
    // Not there, or not JSON: nothing to fill in.
  }
  read.set(nonce, found);
  return found;
}

export const forgetHandoffs = (): void => read.clear();
