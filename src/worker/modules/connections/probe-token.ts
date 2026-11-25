import {
  b64urlDecode,
  b64urlEncode,
  type PageState,
  pageOf,
} from '../../connectors/http-json/cursor.ts';

const PREFIX = 'p1.';
const MAX_TOKEN_CHARS = 4096;
const MAX_IDS = 200;

/** Where the proof stands: the page state a sync would hold, the page and record counts so far, and the last page's IDs. */
export interface ProbeToken {
  p: PageState | null;
  /** Pages read so far. */
  k: number;
  /** Records read so far. */
  n: number;
  /** Short hashes of the IDs on the page just read. */
  ids: string[];
}

/** A 32-bit FNV-1a hash in base 36: enough to count repeated IDs without carrying them. */
export function idHash(value: unknown): string | null {
  const text = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
  if (text === '') return null;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(36);
}

/** The token for the next page; the ID list shrinks until the whole token fits. */
export function encodeToken(token: ProbeToken): string {
  let ids = token.ids.slice(0, MAX_IDS);
  for (;;) {
    const out = `${PREFIX}${b64urlEncode(JSON.stringify({ ...token, ids }))}`;
    if (out.length <= MAX_TOKEN_CHARS || ids.length === 0) return out;
    ids = ids.slice(0, Math.floor(ids.length / 2));
  }
}

/** A token the probe issued, or null. Its page state is re-checked against the origin when it is used. */
export function decodeToken(raw: string): ProbeToken | null {
  if (!raw.startsWith(PREFIX)) return null;
  try {
    const o = JSON.parse(b64urlDecode(raw.slice(PREFIX.length))) as Record<string, unknown>;
    const count = (v: unknown) =>
      Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : null;
    const k = count(o.k);
    const n = count(o.n);
    if (k === null || n === null || !Array.isArray(o.ids)) return null;
    const ids = o.ids.filter((v): v is string => typeof v === 'string' && v.length <= 8);
    return { p: pageOf(o.p), k, n, ids: ids.slice(0, MAX_IDS) };
  } catch {
    return null;
  }
}
