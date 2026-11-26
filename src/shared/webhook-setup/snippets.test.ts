import { execFile, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SAMPLE_BODY,
  SNIPPET_LANGS,
  type SnippetLang,
  selfTestSnippet,
  sendSnippet,
  VERIFY_LANGS,
  type VerifyLang,
  verifySnippet,
} from './snippets.ts';

const run = promisify(execFile);
const has = (bin: string) =>
  spawnSync(bin, ['--version']).status === 0 || spawnSync(bin, ['version']).status === 0;
const HAS = {
  node: true,
  python: has('python3'),
  go: has('go'),
  curl: has('curl') && has('openssl'),
};

const mac = (secret: string, ts: string | number, body: string) =>
  createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

interface Case {
  name: string;
  body: string;
  ts: string;
  signature: string;
  secret: string;
  want: boolean;
}
const SECRET = ['whsec_test_01', '23456789abcdef'].join('');
const BODY = '{"id":"evt-1","note":"héllo"}';
const now = () => Math.floor(Date.now() / 1000);
function cases(): Case[] {
  const ts = String(now());
  const good = `v1=${mac(SECRET, ts, BODY)}`;
  const old = String(now() - 400);
  return [
    { name: 'valid', body: BODY, ts, signature: good, secret: SECRET, want: true },
    {
      name: 'rotation: any live value',
      body: BODY,
      ts,
      signature: `v1=${'0'.repeat(64)}, ${good}`,
      secret: SECRET,
      want: true,
    },
    { name: 'tampered body', body: `${BODY} `, ts, signature: good, secret: SECRET, want: false },
    { name: 'wrong secret', body: BODY, ts, signature: good, secret: 'other', want: false },
    {
      name: 'expired',
      body: BODY,
      ts: old,
      signature: `v1=${mac(SECRET, old, BODY)}`,
      secret: SECRET,
      want: false,
    },
    { name: 'no signature', body: BODY, ts, signature: '', secret: SECRET, want: false },
    {
      name: 'no v1 prefix',
      body: BODY,
      ts,
      signature: mac(SECRET, ts, BODY),
      secret: SECRET,
      want: false,
    },
    { name: 'bad timestamp', body: BODY, ts: 'soon', signature: good, secret: SECRET, want: false },
  ];
}

const DRIVER: Record<
  VerifyLang,
  {
    file: string;
    args: (f: string, json: string) => [string, string[]];
    wrap: (code: string) => string;
  }
> = {
  node: {
    file: 'verify.mjs',
    args: (f, json) => ['node', [f, json]],
    wrap: (code) => `${code}
const out = JSON.parse(process.argv[2]).map((c) => verify(c.body, { 'x-passbook-timestamp': c.ts, 'x-passbook-signature': c.signature }, c.secret));
console.log(JSON.stringify(out));`,
  },
  python: {
    file: 'verify.py',
    args: (f, json) => ['python3', ['-I', f, json]],
    wrap: (code) => `${code}


if __name__ == "__main__":
    import json
    import sys

    cases = json.loads(sys.argv[1])
    print(json.dumps([verify(c["body"].encode(), {"x-passbook-timestamp": c["ts"], "x-passbook-signature": c["signature"]}, c["secret"]) for c in cases]))`,
  },
  go: {
    file: 'verify.go',
    args: (f, json) => ['go', ['run', f, json]],
    wrap: (code) =>
      `${code.replace('package webhook', 'package main')}

func main() {
	var cases []struct{ Body, Ts, Signature, Secret string }
	if err := json.Unmarshal([]byte(os.Args[1]), &cases); err != nil {
		panic(err)
	}
	out := []bool{}
	for _, c := range cases {
		out = append(out, Verify([]byte(c.Body), c.Ts, c.Signature, c.Secret))
	}
	b, _ := json.Marshal(out)
	fmt.Println(string(b))
}`.replace('import (', 'import (\n\t"encoding/json"\n\t"fmt"\n\t"os"'),
  },
};

let dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wh-snippets-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the reference vector', () => {
  it('matches the server vector, so the snippets are checked against the real scheme', () => {
    const file = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../../docs/api/webhook-vectors.json'), 'utf8'),
    ) as {
      vectors: { id: string; body: string; secrets: string[]; headers: Record<string, string> }[];
    };
    const v = file.vectors.find((x) => x.id === 'valid');
    if (!v) throw new Error('no valid vector');
    const ts = v.headers['x-passbook-timestamp'] ?? '';
    expect(`v1=${mac(v.secrets[0] ?? '', ts, v.body)}`).toBe(v.headers['x-passbook-signature']);
  });
});

describe.each(VERIFY_LANGS)('verify snippet: %s', (lang) => {
  it.skipIf(!HAS[lang])(
    'accepts a good signature and refuses every bad one',
    async () => {
      const d = DRIVER[lang];
      const path = join(dir, d.file);
      writeFileSync(path, d.wrap(verifySnippet(lang)));
      const [bin, args] = d.args(path, JSON.stringify(cases()));
      const { stdout } = await run(bin, args, { cwd: dir, timeout: 90_000 });
      const got = JSON.parse(stdout.trim().split('\n').pop() ?? '[]') as boolean[];
      expect(cases().map((c, i) => [c.name, got[i]])).toEqual(cases().map((c) => [c.name, c.want]));
    },
    100_000,
  );
});

describe('self-test snippet', () => {
  it('posts a made-up signature to the receiver', () => {
    const text = selfTestSnippet('https://example.com/hooks');
    expect(text).toContain("'https://example.com/hooks'");
    expect(text).toContain('x-passbook-signature: v1=');
  });
});

interface Seen {
  headers: IncomingMessage['headers'];
  body: string;
}
const SENDERS: Record<SnippetLang, { file: string; cmd: (f: string) => [string, string[]] }> = {
  node: { file: 'send.mjs', cmd: (f) => ['node', [f]] },
  python: { file: 'send.py', cmd: (f) => ['python3', ['-I', f]] },
  go: { file: 'send.go', cmd: (f) => ['go', ['run', f]] },
  curl: { file: 'send.sh', cmd: (f) => ['sh', [f]] },
};

describe.each(SNIPPET_LANGS)('send snippet: %s', (lang) => {
  it.skipIf(!HAS[lang])(
    'posts a request the verifier accepts, with the secret read from the environment',
    async () => {
      const seen: Seen[] = [];
      const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          seen.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
          res.end('ok');
        });
      });
      await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      try {
        const text = sendSnippet(lang, {
          url: `http://127.0.0.1:${port}/hooks/c/1`,
          signatureHeader: 'x-wallet-signature',
          timestampHeader: 'x-wallet-timestamp',
        });
        expect(text).not.toContain(SECRET);
        const path = join(dir, SENDERS[lang].file);
        writeFileSync(path, text);
        const [bin, args] = SENDERS[lang].cmd(path);
        await run(bin, args, {
          cwd: dir,
          env: { ...process.env, PASSBOOK_SECRET: SECRET },
          timeout: 90_000,
        });
        expect(seen).toHaveLength(1);
        const got = seen[0] as Seen;
        expect(JSON.parse(got.body)).toEqual(JSON.parse(SAMPLE_BODY));
        const ts = String(got.headers['x-wallet-timestamp']);
        expect(Math.abs(now() - Number(ts))).toBeLessThan(60);
        expect(got.headers['x-wallet-signature']).toBe(`v1=${mac(SECRET, ts, got.body)}`);
      } finally {
        server.close();
      }
    },
    100_000,
  );
});
