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

/**
 * A new `#pair=` on an already-open /scan (the link opened in the same tab) fires `hashchange`:
 * read it the same way and hand the code over. Returns the cleanup.
 */
export function watchPairLink(
  onCode: (code: string) => void,
  win: Pick<Window, 'addEventListener' | 'removeEventListener' | 'location' | 'history'> = window,
): () => void {
  const onChange = () => {
    taken = null;
    const code = takePairCode(win.location, win.history);
    if (code) onCode(code);
  };
  win.addEventListener('hashchange', onChange);
  return () => win.removeEventListener('hashchange', onChange);
}

/** Test seam: forget the fragment, as a fresh page load would. */
export function resetPairLink(): void {
  taken = null;
}
