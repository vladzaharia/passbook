const BASE = 'http://next.invalid';

/** Same-origin path only; anything else becomes the fallback. Mirrors the server's safeNext. */
export function safeNext(next: string | null | undefined, fallback = '/'): string {
  if (!next || next.length > 512 || !next.startsWith('/')) return fallback;
  if (next.startsWith('//') || next.includes('\\')) return fallback;
  // Tab, CR and LF are stripped by URL parsing, so "/\t/host" would become "//host".
  for (let i = 0; i < next.length; i++) {
    const code = next.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return fallback;
  }
  const rawPath = next.split(/[?#]/, 1)[0] ?? '';
  if (rawPath.split('/').some((seg) => /^(\.|\.\.|%2e|%2e%2e|\.%2e|%2e\.)$/i.test(seg))) {
    return fallback;
  }
  try {
    const url = new URL(next, BASE);
    if (url.origin !== BASE) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

export function loginHref(next: string): string {
  return `/login?next=${encodeURIComponent(safeNext(next))}`;
}
