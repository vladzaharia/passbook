import { TABULAR_LIMITS, TabularError } from './limits.ts';

export interface XmlHandlers {
  /** Names and attribute names are local (the namespace prefix is dropped). */
  open(name: string, attrs: Record<string, string>): void;
  text(text: string): void;
  close(name: string): void;
}

const damaged = () => new TabularError('FILE_DAMAGED', 'The spreadsheet is damaged.');
const unsafe = () =>
  new TabularError('FILE_XML_UNSAFE', 'The spreadsheet uses XML features that are not allowed.');

const local = (name: string) => name.slice(name.lastIndexOf(':') + 1);

function validCodePoint(n: number): boolean {
  return (
    n === 0x9 ||
    n === 0xa ||
    n === 0xd ||
    (n >= 0x20 && n <= 0xd7ff) ||
    (n >= 0xe000 && n <= 0xfffd) ||
    (n >= 0x10000 && n <= 0x10ffff)
  );
}

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Only the 5 predefined entities and numeric references; anything else is refused. */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&([^&;\s]*;?)/g, (_m, body: string) => {
    if (body.endsWith(';')) {
      const ref = body.slice(0, -1);
      const named = Object.hasOwn(NAMED, ref) ? NAMED[ref] : undefined;
      if (named !== undefined) return named;
      const num = /^#(?:x([0-9a-fA-F]{1,6})|([0-9]{1,7}))$/.exec(ref);
      if (num) {
        const code = num[1] ? Number.parseInt(num[1], 16) : Number.parseInt(num[2] ?? '', 10);
        if (validCodePoint(code)) return String.fromCodePoint(code);
      }
    }
    throw unsafe();
  });
}

// Sticky and anchored: each step starts where the last ended, so a body with no `=` is one linear scan.
const ATTR = /\s*([^\s=/"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;

function attributes(body: string): Record<string, string> {
  const attrs: Record<string, string> = Object.create(null);
  let pos = 0;
  while (pos < body.length) {
    ATTR.lastIndex = pos;
    const m = ATTR.exec(body);
    if (!m) {
      if (body.slice(pos).trim() !== '') throw damaged();
      break;
    }
    attrs[local(m[1] ?? '')] = decodeEntities(m[2] ?? m[3] ?? '');
    pos = ATTR.lastIndex;
  }
  return attrs;
}

/**
 * Minimal non-validating XML reader for OOXML parts. It refuses DOCTYPE and ENTITY outright, so
 * nothing is ever expanded, and keeps its own stack (no recursion). Throws TabularError only.
 */
export function parseXml(bytes: Uint8Array, h: XmlHandlers): void {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw damaged();
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (/<!(?:DOCTYPE|ENTITY)/i.test(text)) throw unsafe();
  const n = text.length;
  const stack: string[] = [];
  let i = 0;
  while (i < n) {
    const lt = text.indexOf('<', i);
    const end = lt === -1 ? n : lt;
    if (end > i) {
      const raw = text.slice(i, end);
      if (stack.length > 0) h.text(decodeEntities(raw));
      else if (raw.trim() !== '') throw damaged();
    }
    if (lt === -1) break;
    if (text.startsWith('<!--', lt)) {
      const close = text.indexOf('-->', lt + 4);
      if (close === -1) throw damaged();
      i = close + 3;
    } else if (text.startsWith('<![CDATA[', lt)) {
      const close = text.indexOf(']]>', lt + 9);
      if (close === -1 || stack.length === 0) throw damaged();
      h.text(text.slice(lt + 9, close));
      i = close + 3;
    } else if (text.startsWith('<?', lt)) {
      const close = text.indexOf('?>', lt + 2);
      if (close === -1) throw damaged();
      i = close + 2;
    } else if (text.startsWith('<!', lt)) {
      throw unsafe();
    } else {
      let j = lt + 1;
      let quote = '';
      for (; j < n; j++) {
        const c = text[j] as string;
        if (quote) {
          if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
        if (j - lt > TABULAR_LIMITS.xlsx.xmlTagChars) throw damaged();
      }
      if (j >= n) throw damaged();
      const inner = text.slice(lt + 1, j);
      if (inner.startsWith('/')) {
        const name = local(inner.slice(1).trim());
        if (stack.pop() !== name) throw damaged();
        h.close(name);
      } else {
        const selfClosing = inner.endsWith('/');
        const body = selfClosing ? inner.slice(0, -1) : inner;
        const space = body.search(/\s/);
        const name = local(space === -1 ? body : body.slice(0, space));
        if (name === '') throw damaged();
        const attrs = attributes(space === -1 ? '' : body.slice(space));
        if (stack.length >= TABULAR_LIMITS.xlsx.xmlDepth) throw damaged();
        h.open(name, attrs);
        if (selfClosing) h.close(name);
        else stack.push(name);
      }
      i = j + 1;
    }
  }
  if (stack.length > 0) throw damaged();
}
