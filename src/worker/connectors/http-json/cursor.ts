import { ConnectorError } from '../types.ts';

const PREFIX = 'r2.';
/** One limit for a cursor value or a stored next URL, checked on the way in and on the way out. */
export const MAX_VALUE_CHARS = 4000;
export const MAX_CURSOR_CHARS = 8192;

/**
 * Where the listing stands. `c` a cursor value, `u` the next URL (path and query), `n` a page or offset,
 * `k` pages this run, `s` the first and last record of the page just read (a repeated page ends the listing).
 */
export interface PageState {
  c?: string;
  u?: string;
  n?: number;
  k?: number;
  s?: string;
}

/** `p` page state (null: start at page one), `h` high-water mark, `m` highest seen this run, `w` wait until (ms). */
export interface CursorState {
  p: PageState | null;
  h?: number;
  m?: number;
  w?: number;
}

export function b64urlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function b64urlDecode(text: string): string {
  const std = text.replaceAll('-', '+').replaceAll('_', '/');
  const bytes = Uint8Array.from(atob(std), (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length <= MAX_VALUE_CHARS ? v : undefined;

export function pageOf(raw: unknown): PageState | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const page: PageState = {};
  const c = text(o.c);
  const u = text(o.u);
  if (c !== undefined) page.c = c;
  if (u !== undefined) page.u = u;
  if (num(o.n) !== undefined) page.n = num(o.n) as number;
  if (num(o.k) !== undefined) page.k = num(o.k) as number;
  const sig = typeof o.s === 'string' && o.s.length <= 200 ? o.s : undefined;
  if (sig !== undefined) page.s = sig;
  return page;
}

/**
 * Reads a stored cursor. One that does not start with `r2.` is a v1 feed cursor: the raw value the API
 * gave. A damaged `r2.` cursor starts the listing over, which only repeats work the core already dedupes.
 */
export function decodeCursor(raw: string | null): { state: CursorState; damaged: boolean } {
  if (!raw) return { state: { p: null }, damaged: false };
  if (!raw.startsWith(PREFIX)) return { state: { p: { c: raw } }, damaged: false };
  try {
    const o = JSON.parse(b64urlDecode(raw.slice(PREFIX.length))) as Record<string, unknown>;
    const state: CursorState = { p: pageOf(o.p) };
    for (const key of ['h', 'm', 'w'] as const) {
      const v = num(o[key]);
      if (v !== undefined) state[key] = v;
    }
    return { state, damaged: false };
  } catch {
    return { state: { p: null }, damaged: true };
  }
}

const tooLong = () =>
  new ConnectorError('INVALID_PAYLOAD', { permanent: true, reason: 'CURSOR_TOO_LONG' });

/** A cursor too long to keep is a permanent, named error, raised before the page is applied. */
export function encodeCursor(state: CursorState): string {
  if ((state.p?.c?.length ?? 0) > MAX_VALUE_CHARS || (state.p?.u?.length ?? 0) > MAX_VALUE_CHARS) {
    throw tooLong();
  }
  const body: Record<string, unknown> = { p: state.p };
  for (const key of ['h', 'm', 'w'] as const) if (state[key] !== undefined) body[key] = state[key];
  const out = `${PREFIX}${b64urlEncode(JSON.stringify(body))}`;
  if (out.length > MAX_CURSOR_CHARS) throw tooLong();
  return out;
}
