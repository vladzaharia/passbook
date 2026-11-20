import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  goRawString,
  goString,
  jsonText,
  pyLiteral,
  shQuote,
  tsKey,
  tsLiteral,
  tsString,
} from './code-literals.ts';
import { goBody, PAYLOADS, runPy, runSh, runTs, shapeOf } from './sample-check.ts';
import { samplesFor } from './samples.ts';
import type { Json } from './types.ts';

/** An escape of a lone surrogate (not the text `\\ud800`, whose backslash is escaped), `\/`, or a raw BOM. */
const LONE_SURROGATE_OR_SLASH = /(?<!\\)(?:\\\\)*\\(?:ud[89a-f][0-9a-f]{2}|\/)|\ufeff/i;

const BASE = 'https://passbook.mobile/api/v1';
const sampleOf = (input: Json) =>
  Object.fromEntries(
    samplesFor(
      {
        method: 'post',
        path: '/passes',
        idempotent: true,
        requestExample: { templateId: 'baked:starter-store-card', input },
      },
      BASE,
    ).map((s) => [s.lang, s.code]),
  ) as Record<'ts' | 'curl' | 'py' | 'go', string>;

describe('code literals', () => {
  it('a TypeScript string cannot be left early, whatever it holds', () => {
    for (const text of Object.values(PAYLOADS)) {
      // The literal, read back as JavaScript, is the text: nothing before or after it.
      expect(runInNewContext(tsString(text), {})).toBe(
        text.replace(/\ud800(?![\udc00-\udfff])/g, '\ufffd'),
      );
    }
    expect(tsString("it's")).toBe("'it\\'s'");
    expect(tsString('a"b')).toBe("'a\"b'");
    expect(tsString('\\')).toBe("'\\\\'");
  });

  it('keys are quoted unless they are plain names, and __proto__ stays a key', () => {
    expect(tsKey('points')).toBe('points');
    expect(tsKey("x'); y('")).toBe("'x\\'); y(\\''");
    const obj = runInNewContext(
      `(${tsLiteral(JSON.parse('{"__proto__":1}') as Json)})`,
      {},
    ) as object;
    expect(Object.keys(obj)).toEqual(['__proto__']);
  });

  it('shell words hold their value and nothing else', () => {
    expect(shQuote("a'b")).toBe(`'a'\\''b'`);
    expect(shQuote('$(id)')).toBe("'$(id)'");
  });

  it('Go and Python literals use only escapes both languages have, and no lone surrogate', () => {
    for (const text of Object.values(PAYLOADS)) {
      expect(goString(text)).not.toMatch(LONE_SURROGATE_OR_SLASH);
      expect(jsonText({ text })).not.toMatch(LONE_SURROGATE_OR_SLASH);
    }
    expect(goRawString('a`b')).toBe('`a` + "`" + `b`');
    expect(pyLiteral({ k: ['x', true, null, 1.5] }, '')).toBe(
      '{\n    "k": [\n        "x",\n        True,\n        None,\n        1.5,\n    ],\n}',
    );
  });
});

describe('samples built from hostile values', () => {
  const benign: Json = {
    name: 'Casey River',
    note: 'plain',
    points: 180,
    ok: true,
    tags: ['a', 'b'],
  };
  const shapes = Object.fromEntries(
    Object.entries(sampleOf(benign)).map(([lang, code]) => [lang, shapeOf(lang as 'ts', code)]),
  );
  const hostile = (text: string): Json => ({
    name: text,
    note: text,
    points: 180,
    ok: true,
    tags: [text, 'b'],
  });

  it.each(Object.entries(PAYLOADS))(
    '%s in a value: same program, the value stays data',
    async (_name, text) => {
      const code = sampleOf(hostile(text));
      // 1. Outside its string literals each sample is the sample of a harmless value.
      for (const lang of ['ts', 'curl', 'py', 'go'] as const)
        expect(shapeOf(lang, code[lang]), lang).toBe(shapes[lang]);

      const expected = JSON.parse(
        jsonText({ templateId: 'baked:starter-store-card', input: hostile(text) }),
      );
      // 2. TypeScript: one request, the value in its body, the key only in the header.
      const calls = await runTs(code.ts, 'SECRET-KEY');
      expect(calls).toHaveLength(1);
      expect(JSON.parse(calls[0]?.init.body ?? '')).toEqual(expected);
      expect(calls[0]?.init.headers.Authorization).toBe('Bearer SECRET-KEY');
      expect(calls[0]?.init.body).not.toContain('SECRET-KEY');
      // 3. curl in sh: one command, the body byte for byte, nothing expanded or run.
      const sh = runSh(code.curl, 'SECRET-KEY');
      expect(sh.status).toBe(0);
      expect(sh.stdout).not.toContain('INJECTED');
      expect(sh.args.slice(0, 2)).toEqual(['-X', 'POST']);
      expect(JSON.parse(sh.args[sh.args.indexOf('-d') + 1] ?? '')).toEqual(expected);
      expect(sh.args.join(' ')).not.toContain('SECRET-KEY\n');
      expect(sh.args[sh.args.indexOf('-d') + 1]).not.toContain('SECRET-KEY');
      // 4. Go: the body expression decodes to the JSON, and every escape is one Go has.
      expect(JSON.parse(goBody(code.go))).toEqual(expected);
      // 5. Python, where python3 is installed: one call, the same json.
      const py = runPy(code.py, 'SECRET-KEY');
      if (py.ran) expect(py.sent).toEqual(expected);
    },
  );

  it('a hostile key is data too', async () => {
    const key = PAYLOADS.ts;
    const input: Json = { [key]: 1, 'a b': 2 };
    const code = sampleOf(input);
    const quoted = sampleOf({ 'x y': 1, 'a b': 2 });
    for (const lang of ['ts', 'curl', 'py', 'go'] as const)
      expect(shapeOf(lang, code[lang]), lang).toBe(shapeOf(lang, quoted[lang]));
    const calls = await runTs(code.ts, 'SECRET-KEY');
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]?.init.body ?? '').input).toEqual(input);
    expect(runSh(code.curl, 'k').stdout).not.toContain('INJECTED');
  });
});
