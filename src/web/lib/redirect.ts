/** Same-origin path only; anything else becomes the fallback. */
export function safeNext(next: string | null | undefined, fallback = '/'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) {
    return fallback;
  }
  return next;
}

export function loginHref(next: string): string {
  return `/login?next=${encodeURIComponent(safeNext(next))}`;
}
