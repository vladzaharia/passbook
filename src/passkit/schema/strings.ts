export interface ParsedStrings {
  entries: Map<string, string>;
  duplicates: string[];
  /** Syntax problem with its 1-based line, or undefined. */
  error?: { message: string; line: number };
}

export type StringsDecode =
  | { ok: true; text: string; encoding: 'utf-8' | 'utf-16le' | 'utf-16be'; bom: boolean }
  | { ok: false; message: string };

/** pass.strings is UTF-16 per Apple; UTF-8 is common. The BOM decides. */
export function decodeStrings(bytes: Uint8Array): StringsDecode {
  const b0 = bytes[0];
  const b1 = bytes[1];
  try {
    if (b0 === 0xff && b1 === 0xfe)
      return {
        ok: true,
        text: new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true }).decode(
          bytes.subarray(2),
        ),
        encoding: 'utf-16le',
        bom: true,
      };
    if (b0 === 0xfe && b1 === 0xff) {
      const swapped = new Uint8Array(bytes.length - 2);
      for (let i = 2; i + 1 < bytes.length; i += 2) {
        swapped[i - 2] = bytes[i + 1] as number;
        swapped[i - 1] = bytes[i] as number;
      }
      return {
        ok: true,
        text: new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true }).decode(swapped),
        encoding: 'utf-16be',
        bom: true,
      };
    }
    const bom = b0 === 0xef && b1 === 0xbb && bytes[2] === 0xbf;
    return {
      ok: true,
      text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        bom ? bytes.subarray(3) : bytes,
      ),
      encoding: 'utf-8',
      bom,
    };
  } catch {
    return { ok: false, message: 'Not valid UTF-8 or UTF-16 text.' };
  }
}

const ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  '"': '"',
  '\\': '\\',
  "'": "'",
};

/** Parses `"key" = "value";` entries with /* *\/ and // comments. */
export function parseStrings(text: string): ParsedStrings {
  const entries = new Map<string, string>();
  const duplicates: string[] = [];
  let i = 0;
  let line = 1;
  const fail = (message: string): ParsedStrings => ({
    entries,
    duplicates,
    error: { message, line },
  });

  const skip = (): string | undefined => {
    for (;;) {
      const c = text[i];
      if (c === '\n') line++;
      if (c !== undefined && /\s/.test(c)) i++;
      else if (text.startsWith('//', i)) {
        while (i < text.length && text[i] !== '\n') i++;
      } else if (text.startsWith('/*', i)) {
        const end = text.indexOf('*/', i + 2);
        if (end < 0) return 'Unterminated comment.';
        line += (text.slice(i, end).match(/\n/g) ?? []).length;
        i = end + 2;
      } else return undefined;
    }
  };
  const readString = (): string | { error: string } => {
    if (text[i] !== '"') return { error: 'Expected a quoted string.' };
    i++;
    let out = '';
    for (;;) {
      const c = text[i++];
      if (c === undefined || c === '\n') return { error: 'Unterminated string.' };
      if (c === '"') return out;
      if (c !== '\\') {
        out += c;
        continue;
      }
      const e = text[i++];
      if (e === 'U' || e === 'u') {
        const hex = text.slice(i, i + 4);
        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return { error: 'Invalid unicode escape.' };
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 4;
      } else if (e !== undefined && e in ESCAPES) out += ESCAPES[e];
      else return { error: 'Invalid escape sequence.' };
    }
  };

  for (;;) {
    const problem = skip();
    if (problem) return fail(problem);
    if (i >= text.length) break;
    const key = readString();
    if (typeof key !== 'string') return fail(key.error);
    const p1 = skip();
    if (p1) return fail(p1);
    if (text[i++] !== '=') return fail('Expected =.');
    const p2 = skip();
    if (p2) return fail(p2);
    const value = readString();
    if (typeof value !== 'string') return fail(value.error);
    const p3 = skip();
    if (p3) return fail(p3);
    if (text[i++] !== ';') return fail('Expected ;.');
    if (entries.has(key)) duplicates.push(key);
    entries.set(key, value);
  }
  return { entries, duplicates };
}
