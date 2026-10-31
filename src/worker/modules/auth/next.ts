const BASE = 'http://next.invalid';

/** Same-origin relative path or null. Absolute, protocol-relative and backslash forms are refused. */
export function safeNext(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 512 || !raw.startsWith('/')) return null;
  if (raw.startsWith('//') || raw.includes('\\') || /\s/.test(raw)) return null;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
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

export function nextOrHome(raw: string | null | undefined): string {
  return safeNext(raw) ?? '/';
}
