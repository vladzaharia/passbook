/**
 * Normalizing a read (AC 2.2). The server normalizes again; the client only does what keeps data on
 * the device: control characters, size, and links that must never be sent.
 */
import type { LocalRefusal, RawRead } from './types.ts';

export interface Normalized {
  code?: string;
  passId?: string;
  sig: string;
  local?: LocalRefusal;
}

const MAX_BYTES = 1024;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROLS = /[\u0000-\u001f\u007f]/g;
const bytes = (text: string) => new TextEncoder().encode(text).length;

function ownLink(code: string, origins: readonly string[]): URL | null {
  if (!/^https?:\/\//i.test(code)) return null;
  try {
    const url = new URL(code);
    return origins.includes(url.origin) ? url : null;
  } catch {
    return null;
  }
}

/** `origins` are the origins whose links are ours: `location.origin` and the public base URL. */
export function normalizeRead(raw: RawRead, origins: readonly string[]): Normalized {
  if (raw.passId !== undefined && raw.code === undefined)
    return { passId: raw.passId, sig: `p:${raw.passId}` };
  const code = (raw.code ?? '').replace(CONTROLS, '').trim();
  const sig = `c:${code}`;
  if (code === '' || bytes(code) > MAX_BYTES) return { code, sig, local: 'not_found' };
  const url = ownLink(code, origins);
  if (url) {
    const add = /^\/[pb]\/[^/]/.test(url.pathname);
    return { code, sig, local: add ? 'add_link' : 'not_found' };
  }
  return { code, sig };
}
