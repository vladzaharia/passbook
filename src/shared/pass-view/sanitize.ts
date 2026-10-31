import type { Segment } from './types.ts';

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decode(s: string): string {
  return s.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]+));/gi, (m, dec, hex, name) => {
    if (name) return NAMED[name.toLowerCase()] ?? m;
    const cp = dec ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)
      ? String.fromCodePoint(cp)
      : m;
  });
}

/** Allow https, tel and mailto only. Returns undefined for anything else. */
export function safeHref(raw: string): string | undefined {
  // Browsers ignore tabs, newlines and control chars inside a scheme, so strip them first.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
  const url = raw.replace(/[\u0000- \u007f-\u009f]/g, '');
  if (/^https:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && u.hostname && !u.username && !u.password
        ? u.href
        : undefined;
    } catch {
      return undefined;
    }
  }
  if (/^(tel|mailto):[^<>"'`\\]+$/i.test(url)) return url;
  return undefined;
}

function push(out: Segment[], text: string, href: string | undefined) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.href === href) last.text += text;
  else out.push(href ? { text, href } : { text });
}

/**
 * Reduce `attributedValue` markup to text segments. Only `<a href>` survives, and only with a
 * safe scheme; every other tag is dropped. Output is plain data, so React escapes the text.
 */
export function parseAttributed(html: string): Segment[] {
  const src = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const out: Segment[] = [];
  let href: string | undefined;
  let last = 0;
  for (const m of src.matchAll(/<(\/?)([a-z][a-z0-9]*)\b([^>]*)>/gi)) {
    push(out, decode(src.slice(last, m.index)), href);
    last = m.index + m[0].length;
    if (m[2]?.toLowerCase() !== 'a') continue;
    if (m[1]) {
      href = undefined;
      continue;
    }
    const attr = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[3] ?? '');
    const value = attr ? (attr[1] ?? attr[2] ?? attr[3] ?? '') : '';
    href = safeHref(decode(value));
  }
  push(out, decode(src.slice(last)), href);
  return out;
}

export type Detector = 'link' | 'phone';

const AUTO = /(https?:\/\/[^\s<>"]+)|([\w.+-]+@[\w-]+(?:\.[\w-]+)+)|(\+?\d[\d\s().-]{5,}\d)/g;

/** Linkify plain text the way Wallet's data detectors do on back fields. */
export function autolink(text: string, detectors: ReadonlySet<Detector>): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(AUTO)) {
    let match = m[0];
    let href: string | undefined;
    if (m[1] && detectors.has('link')) {
      match = match.replace(/[.,;:!?)\]]+$/, '');
      href = safeHref(match);
    } else if (m[2] && detectors.has('link')) {
      href = safeHref(`mailto:${match}`);
    } else if (m[3] && detectors.has('phone')) {
      const digits = match.replace(/\D/g, '');
      if (digits.length >= 7 && digits.length <= 15 && !/^\d{4}-\d{2}-\d{2}$/.test(match.trim())) {
        href = safeHref(`tel:${match.trim().startsWith('+') ? '+' : ''}${digits}`);
      }
    }
    if (!href) continue;
    push(out, text.slice(last, m.index), undefined);
    push(out, match, href);
    last = m.index + match.length;
  }
  push(out, text.slice(last), undefined);
  return out;
}
