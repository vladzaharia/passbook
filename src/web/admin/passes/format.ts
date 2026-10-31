export function formatDate(ms: number | null | undefined): string {
  return ms ? new Date(ms).toLocaleString() : 'Never';
}

export function newKey(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `k-${Math.random().toString(36).slice(2)}-${Date.now()}`
  );
}

/** Stable JSON for fingerprints: same inputs give the same string. */
export function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );
}

export function absoluteUrl(path: string): string {
  try {
    return new URL(path, window.location.origin).toString();
  } catch {
    return path;
  }
}
