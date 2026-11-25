import { ConnectorError } from '../types.ts';

const PREFIX = 'r2.';
export const MAX_CURSOR_CHARS = 2048;

/** Where the listing stands. `c` a cursor value, `u` the next URL (path and query), `n` a page or offset, `k` pages this run. */
export interface PageState {
  c?: string;
  u?: string;
  n?: number;
  k?: number;
}

/** `p` page state (null: start at page one), `h` high-water mark, `m` highest seen this run, `w` wait until (ms). */
export interface CursorState {
  p: PageState | null;
  h?: number;
  m?: number;
  w?: number;
}

function b64urlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function b64urlDecode(text: string): string {
  const std = text.replaceAll('-', '+').replaceAll('_', '/');
  const bytes = Uint8Array.from(atob(std), (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const text = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.length <= max ? v : undefined;

function pageOf(raw: unknown): PageState | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const page: PageState = {};
  const c = text(o.c, 600);
  const u = text(o.u, 600);
  if (c !== undefined) page.c = c;
  if (u !== undefined) page.u = u;
  if (num(o.n) !== undefined) page.n = num(o.n) as number;
  if (num(o.k) !== undefined) page.k = num(o.k) as number;
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

export function encodeCursor(state: CursorState): string {
  const body: Record<string, unknown> = { p: state.p };
  for (const key of ['h', 'm', 'w'] as const) if (state[key] !== undefined) body[key] = state[key];
  const out = `${PREFIX}${b64urlEncode(JSON.stringify(body))}`;
  if (out.length > MAX_CURSOR_CHARS) throw new ConnectorError('INVALID_PAYLOAD');
  return out;
}
