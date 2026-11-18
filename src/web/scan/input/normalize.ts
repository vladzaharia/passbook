/**
 * Normalizing a read (AC 2.2). The server normalizes again; the client only does what keeps data on
 * the device: control characters, size, and links that must never be sent.
 */
import type { TagRead } from '../../../shared/contracts/nfc-tags.ts';
import type { LocalRefusal, RawRead } from './types.ts';

export interface Normalized {
  code?: string;
  tag?: TagRead;
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

/** FNV-1a: a short stable key for an NDEF record. It dedupes reads on the device and is never sent. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/** `t:<uid>` or `t:n<hash of the record>`. The UID is lowercased so both readers agree. */
export function tagSignature(tag: TagRead): string {
  return tag.uid
    ? `t:${tag.uid.toLowerCase()}`
    : `t:n${hash(`${tag.ndef?.type}:${tag.ndef?.value}`)}`;
}

/** `origins` are the origins whose links are ours: `location.origin` and the public base URL. */
export function normalizeRead(raw: RawRead, origins: readonly string[]): Normalized {
  if (raw.tag) {
    const tag: TagRead = {
      ...raw.tag,
      ...(raw.tag.ndef
        ? { ndef: { ...raw.tag.ndef, value: raw.tag.ndef.value.replace(CONTROLS, '') } }
        : {}),
    };
    if (!tag.uid && !tag.ndef) return { tag, sig: 't:none', local: 'not_found' };
    return { tag, sig: tagSignature(tag) };
  }
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
