import { describe, expect, it } from 'vitest';
import { validatePass } from '../validate.ts';
import { FIXTURES } from './fixtures.ts';
import { decodeStrings, parseStrings } from './strings.ts';

const utf16le = (text: string) => {
  const out = new Uint8Array(2 + text.length * 2);
  out.set([0xff, 0xfe]);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out[2 + i * 2] = code & 255;
    out[3 + i * 2] = code >> 8;
  }
  return out;
};
const utf16be = (text: string) => {
  const le = utf16le(text);
  const out = new Uint8Array(le.length);
  out.set([0xfe, 0xff]);
  for (let i = 2; i < le.length; i += 2) {
    out[i] = le[i + 1] as number;
    out[i + 1] = le[i] as number;
  }
  return out;
};

describe('decodeStrings', () => {
  const text = '"k" = "caf\u00e9";';
  it('decodes UTF-16 LE and BE by BOM', () => {
    expect(decodeStrings(utf16le(text))).toMatchObject({ ok: true, text, encoding: 'utf-16le' });
    expect(decodeStrings(utf16be(text))).toMatchObject({ ok: true, text, encoding: 'utf-16be' });
  });
  it('decodes UTF-8 with and without BOM', () => {
    const bytes = new TextEncoder().encode(text);
    expect(decodeStrings(bytes)).toMatchObject({ ok: true, text, bom: false });
    expect(decodeStrings(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes]))).toMatchObject({
      ok: true,
      text,
      bom: true,
    });
  });
  it('rejects bytes that are neither', () => {
    expect(decodeStrings(new Uint8Array([0x22, 0xff, 0xfd, 0x80]))).toMatchObject({ ok: false });
  });
});

describe('parseStrings', () => {
  it('parses entries, comments and escapes', () => {
    const r = parseStrings('/* head */\n"a" = "x\\ny";\n// c\n"b"="\\"q\\" \\U00e9";\n');
    expect(r.error).toBeUndefined();
    expect([...r.entries]).toEqual([
      ['a', 'x\ny'],
      ['b', '"q" \u00e9'],
    ]);
  });
  it('reports the line of a syntax error', () => {
    expect(parseStrings('"a" = "b";\n"c" = "d"\n"e" = "f";').error).toMatchObject({ line: 3 });
    expect(parseStrings('"a" = "b').error).toBeDefined();
    expect(parseStrings('a = "b";').error).toBeDefined();
    expect(parseStrings('"a" "b";').error).toBeDefined();
    expect(parseStrings('/* open').error).toBeDefined();
    expect(parseStrings('"a" = "\\q";').error).toBeDefined();
  });
  it('lists duplicate keys', () => {
    expect(parseStrings('"a" = "1"; "a" = "2";').duplicates).toEqual(['a']);
  });
  it('accepts an empty file', () => {
    expect(parseStrings('').entries.size).toBe(0);
  });
});

describe('localization validation', () => {
  const f = FIXTURES[0];
  if (!f) throw new Error('fixture');
  const assets = [
    ...f.assets,
    { name: 'en.lproj/pass.strings' },
    { name: 'fr.lproj/pass.strings' },
  ];
  const run = (strings: Record<string, Uint8Array | string>) =>
    validatePass(f.pass, assets, f.identity, { strings });
  const codes = (r: ReturnType<typeof run>) => r.issues.map((i) => `${i.severity}:${i.code}`);

  it('accepts equal key sets in different encodings', () => {
    const r = run({
      'en.lproj/pass.strings': '"a" = "A";',
      'fr.lproj/pass.strings': utf16le('"a" = "caf\u00e9";'),
    });
    expect(r.issues).toEqual([]);
  });
  it('rejects different key sets', () => {
    expect(
      codes(run({ 'en.lproj/pass.strings': '"a" = "1";', 'fr.lproj/pass.strings': '"b" = "1";' })),
    ).toContain('error:STRINGS_KEYS');
  });
  it('rejects syntax errors and bad encodings', () => {
    expect(codes(run({ 'en.lproj/pass.strings': '"a" = ' }))).toContain('error:STRINGS_SYNTAX');
    expect(codes(run({ 'en.lproj/pass.strings': new Uint8Array([0x22, 0xff, 0xfd]) }))).toContain(
      'error:STRINGS_ENCODING',
    );
  });
  it('warns on non-ASCII UTF-8 without a BOM and on duplicate keys', () => {
    expect(
      codes(run({ 'en.lproj/pass.strings': new TextEncoder().encode('"a" = "caf\u00e9";') })),
    ).toContain('warning:STRINGS_ENCODING');
    expect(codes(run({ 'en.lproj/pass.strings': '"a" = "1"; "a" = "2";' }))).toContain(
      'warning:STRINGS_DUPLICATE',
    );
  });
  it('skips files whose content is not supplied', () => {
    expect(run({}).issues).toEqual([]);
  });
});
