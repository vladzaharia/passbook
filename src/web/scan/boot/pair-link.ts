/**
 * The pairing link `/scan#pair=CODE`. The fragment never reaches a server log, and it is removed
 * from the address bar before any request is made.
 */

const MAX_CODE = 64;

let taken: { code: string | null } | null = null;

/**
 * Reads `#pair=` once and replaces the history entry with `/scan`. A second call (StrictMode runs
 * effects twice) returns the same answer and touches nothing.
 */
export function takePairCode(
  loc: Pick<Location, 'hash'> = window.location,
  hist: Pick<History, 'replaceState'> = window.history,
): string | null {
  if (taken) return taken.code;
  const params = new URLSearchParams(loc.hash.replace(/^#/, ''));
  if (!params.has('pair')) {
    taken = { code: null };
    return null;
  }
  hist.replaceState(null, '', '/scan');
  const code = (params.get('pair') ?? '').trim();
  taken = { code: code.length > 0 && code.length <= MAX_CODE ? code : null };
  return taken.code;
}

/** Test seam: forget the fragment, as a fresh page load would. */
export function resetPairLink(): void {
  taken = null;
}
