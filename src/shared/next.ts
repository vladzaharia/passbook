const BASE = 'http://next.invalid';

/**
 * Pocket ID's end-session returns to a bare /login, so a sign-out-to-switch leaves its next here:
 * set by the logout POST, read once by the sign-in page (web/lib/session.ts), then cleared.
 */
export const NEXT_COOKIE = 'wallet-next';
export const NEXT_COOKIE_PATH = '/login';
export const NEXT_COOKIE_MAX_AGE_S = 300;

/** Same-origin relative path or null, shared by the Worker and the SPA. Absolute, protocol-relative and backslash forms are refused. */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 512 || !raw.startsWith('/')) return null;
  if (raw.startsWith('//') || raw.includes('\\') || /\s/.test(raw)) return null;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return null;
  }
  // URL parsing would resolve dot segments away, so inspect the raw path.
  const rawPath = raw.split(/[?#]/, 1)[0] ?? '';
  if (rawPath.split('/').some((seg) => /^(\.|\.\.|%2e|%2e%2e|\.%2e|%2e\.)$/i.test(seg)))
    return null;
  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return null;
  }
  if (url.origin !== BASE) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Where a signed-in person lands: a safe `next`, else the console for admins, My passes for holders. */
export function homeFor(roles: readonly string[], next?: string | null): string {
  return safeNextPath(next) ?? (roles.includes('admin') ? '/admin' : '/');
}
