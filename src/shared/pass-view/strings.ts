/** Parse a `pass.strings` file body: `"key" = "value";` with C-style escapes and comments. */
export function parsePassStrings(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const unesc = (s: string) =>
    s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c: string) => {
      if (c[0] === 'u' && c.length === 5)
        return String.fromCharCode(Number.parseInt(c.slice(1), 16));
      return c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c;
    });
  for (const m of src.matchAll(/"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/g)) {
    out[unesc(m[1] as string)] = unesc(m[2] as string);
  }
  return out;
}

export function localize(strings: Record<string, string> | undefined, key: string): string {
  if (!strings) return key;
  return Object.hasOwn(strings, key) ? (strings[key] as string) : key;
}
