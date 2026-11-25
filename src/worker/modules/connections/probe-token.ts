import {
  b64urlDecode,
  b64urlEncode,
  type PageState,
  pageOf,
} from '../../connectors/http-json/cursor.ts';

const PREFIX = 'p2.';
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

/** What binds a token: a MAC over the org, the connection (or none), the origin, the base path and the token body. */
export interface TokenKit {
  /** Keyed digest of a string; the platform's, so a token cannot be made without the server's key. */
  mac(value: string): Promise<string>;
  /** `org|connection|origin|basePath`. */
  bind: string;
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
export async function encodeToken(token: ProbeToken, kit: TokenKit): Promise<string> {
  let ids = token.ids.slice(0, MAX_IDS);
  for (;;) {
    const body = b64urlEncode(JSON.stringify({ ...token, ids }));
    const out = `${PREFIX}${body}.${await kit.mac(`${kit.bind}.${body}`)}`;
    if (out.length <= MAX_TOKEN_CHARS || ids.length === 0) return out;
    ids = ids.slice(0, Math.floor(ids.length / 2));
  }
}

/** A token this probe issued for this org, connection, origin and base path, or null. */
export async function decodeToken(raw: string, kit: TokenKit): Promise<ProbeToken | null> {
  if (!raw.startsWith(PREFIX)) return null;
  const [body, mac, ...rest] = raw.slice(PREFIX.length).split('.');
  if (!body || !mac || rest.length > 0) return null;
  const want = await kit.mac(`${kit.bind}.${body}`);
  // Both are fixed-length hex; compare every character.
  let diff = want.length ^ mac.length;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ (mac.charCodeAt(i) || 0);
  if (diff !== 0) return null;
  try {
    const o = JSON.parse(b64urlDecode(body)) as Record<string, unknown>;
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
