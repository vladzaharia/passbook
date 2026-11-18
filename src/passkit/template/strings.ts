export class StringsError extends Error {}

/** UTF-8 or UTF-16 (by BOM) text. UTF-16 without a BOM is rejected. */
export function decodeStrings(bytes: Uint8Array): string {
  const b0 = bytes[0];
  const b1 = bytes[1];
  if (b0 === 0xff && b1 === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (b0 === 0xfe && b1 === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
    b0 === 0xef && b1 === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes,
  );
  if (text.includes('\0')) throw new StringsError('Strings file is not UTF-8 or UTF-16 with BOM.');
  return text;
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' };

/** Parses `"key" = "value";` pairs with comments. */
export function parseStrings(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  const skip = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i] as string)) i++;
      if (text.startsWith('//', i)) {
        while (i < text.length && text[i] !== '\n') i++;
      } else if (text.startsWith('/*', i)) {
        const end = text.indexOf('*/', i + 2);
        if (end < 0) throw new StringsError('Unterminated comment.');
        i = end + 2;
      } else return;
    }
  };
  const quoted = (): string => {
    if (text[i] !== '"') throw new StringsError(`Expected a quote at offset ${i}.`);
    i++;
    let value = '';
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') {
        const next = text[i + 1] ?? '';
        if (next === 'U' || next === 'u') {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new StringsError('Invalid unicode escape.');
          value += String.fromCharCode(Number.parseInt(hex, 16));
          i += 6;
          continue;
        }
        value += ESCAPES[next] ?? next;
        i += 2;
      } else value += text[i++];
    }
    if (text[i] !== '"') throw new StringsError('Unterminated string.');
    i++;
    return value;
  };
  for (;;) {
    skip();
    if (i >= text.length) break;
    const key = quoted();
    skip();
    if (text[i++] !== '=') throw new StringsError(`Expected = after "${key}".`);
    skip();
    const value = quoted();
    skip();
    if (text[i++] !== ';') throw new StringsError(`Expected ; after "${key}".`);
    out.set(key, value);
  }
  return out;
}
