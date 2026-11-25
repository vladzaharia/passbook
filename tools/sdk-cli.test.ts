import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { Api, Capture } from '../sdk/cli/src/api.ts';
import { CLI_VERSION, run } from '../sdk/cli/src/cli.ts';
import { receiverUrl } from '../sdk/cli/src/forward.ts';
import { listen } from '../sdk/cli/src/listen.ts';
import { inputTypeFile, typeName } from '../sdk/cli/src/types-gen.ts';
import { SDK_VERSION } from '../sdk/typescript/src/version.ts';
import { verifyWebhook } from '../sdk/typescript/src/webhooks.ts';

const root = resolve(import.meta.dirname, '..');
interface Vector {
  id: string;
  body: string;
  sdk: string;
  secrets: string[];
  headers: Record<string, string>;
  now: number;
}
const vectors = (
  JSON.parse(readFileSync(resolve(root, 'docs/api/webhook-vectors.json'), 'utf8')) as {
    vectors: Vector[];
  }
).vectors;

const captureOf = (v: Vector, n: number): Capture => ({
  id: `cap${n}`,
  eventId: v.headers['x-passbook-event-id'] ?? `evt${n}`,
  type: v.headers['x-passbook-event-type'] ?? 'pass.updated',
  headers: v.headers,
  body: v.body,
  createdAt: 1_000 + n,
});

const calls: Array<Record<string, unknown>> = [];

/** A capture endpoint whose list is newest first, and a template that has an input schema. */
function fakeApi(pages: () => Capture[], schema: Record<string, unknown> = {}): Api {
  return {
    webhookEndpoints: {
      ensureCapture: async () => ({ endpoint: { id: 'ep1' }, secret: 'whsec_made' }),
      captures: {
        list: async (_id, query) => {
          const all = pages();
          const start = query?.cursor ? Number(query.cursor) : 0;
          const limit = query?.limit ?? 50;
          const items = all.slice(start, start + limit);
          return {
            items,
            nextCursor: start + limit < all.length ? String(start + limit) : null,
          };
        },
        revealSecret: async () => ({ secret: 'whsec_revealed' }),
      },
    },
    templates: {
      retrieve: async () => ({ name: 'Event ticket' }),
      retrieveInputSchema: async () => schema,
    },
    passes: {
      create: async (body, options) => {
        calls.push({ op: 'create', body, options });
        return { id: 'pass_1' };
      },
      update: async (id, body, options) => {
        calls.push({ op: 'update', id, body, options });
        return { id };
      },
    },
  };
}

interface Received {
  body: string;
  headers: IncomingHttpHeaders;
}

/** A receiver that records the raw bytes it was sent. */
async function receiver(status = 200) {
  const got: Received[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      got.push({ body: Buffer.concat(chunks).toString('utf8'), headers: req.headers });
      res.statusCode = status;
      res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    got,
    url: `127.0.0.1:${port}/hooks`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('passbook listen', () => {
  it('forwards each capture with its original body and signature, so every golden vector verifies as it does in the SDK', async () => {
    const rx = await receiver();
    const log: string[] = [];
    // Newest first, as the API lists them.
    const captures = vectors.map(captureOf).reverse();
    const sent = await listen({
      api: fakeApi(() => captures),
      forwardTo: rx.url,
      fromStart: true,
      once: true,
      log: (l) => log.push(l),
    });
    await rx.close();

    expect(sent).toBe(vectors.length);
    // Oldest first.
    expect(rx.got.map((g) => g.headers['x-passbook-timestamp'])).toEqual(
      vectors.map((v) => v.headers['x-passbook-timestamp']),
    );
    for (const [i, v] of vectors.entries()) {
      const got = rx.got[i] as Received;
      expect(got.body).toBe(v.body);
      expect(got.headers['x-passbook-signature']).toBe(v.headers['x-passbook-signature']);
      const verify = () =>
        verifyWebhook(got.body, got.headers, v.secrets[0] as string, { now: v.now });
      if (v.sdk === 'ok')
        await expect(verify()).resolves.toMatchObject({ type: expect.any(String) });
      else await expect(verify()).rejects.toMatchObject({ reason: v.sdk });
    }
    expect(log[0]).toBe('Signing secret: whsec_made');
    expect(log.filter((l) => l.includes('200 ('))).toHaveLength(vectors.length);
  });

  it('forwards only what arrives after it starts, and each capture once', async () => {
    const rx = await receiver();
    const all = vectors.map(captureOf);
    let visible = 2;
    const polls: number[] = [];
    const sent = await listen({
      api: fakeApi(() => all.slice(0, visible).reverse()),
      forwardTo: rx.url,
      log: () => undefined,
      sleep: async () => {
        polls.push(visible);
        if (polls.length === 1) visible = 4;
        if (polls.length === 2) visible = 5;
        if (polls.length === 4) stop.abort();
      },
      signal: (stop as AbortController).signal,
    });
    await rx.close();
    expect(sent).toBe(3);
    expect(rx.got.map((g) => g.body)).toEqual(all.slice(2, 5).map((c) => c.body));
  });

  it('walks back through pages to catch a burst, in order', async () => {
    const rx = await receiver();
    const many = Array.from({ length: 130 }, (_, i) => ({
      ...captureOf(vectors[0] as Vector, i),
      body: `{"n":${i}}`,
    }));
    const sent = await listen({
      api: fakeApi(() => [...many].reverse()),
      forwardTo: rx.url,
      fromStart: true,
      once: true,
      log: () => undefined,
    });
    await rx.close();
    expect(sent).toBe(130);
    expect(rx.got.map((g) => g.body)).toEqual(many.map((c) => c.body));
  });

  it('reports a receiver that is down and keeps going', async () => {
    const log: string[] = [];
    const sent = await listen({
      api: fakeApi(() => [captureOf(vectors[0] as Vector, 1)]),
      forwardTo: 'http://127.0.0.1:1/hooks',
      fromStart: true,
      once: true,
      log: (l) => log.push(l),
    });
    expect(sent).toBe(1);
    expect(log.some((l) => l.includes('failed:'))).toBe(true);
  });

  it('names a receiver with or without a scheme, and refuses other schemes', () => {
    expect(receiverUrl('localhost:3000/hooks')).toBe('http://localhost:3000/hooks');
    expect(receiverUrl('https://example.test/x')).toBe('https://example.test/x');
    expect(() => receiverUrl('ftp://example.test/x')).toThrow(/http or https/);
  });
});

const stop = new AbortController();

describe('passbook types', () => {
  const templates = readdirSync(resolve(root, 'templates'))
    .map((d) => resolve(root, 'templates', d, 'wallet.template.json'))
    .flatMap((file) => {
      try {
        const m = JSON.parse(readFileSync(file, 'utf8')) as {
          name: string;
          inputs: Record<string, unknown>;
          sample?: Record<string, unknown>;
        };
        return [m];
      } catch {
        return [];
      }
    });

  it('emits types that compile and accept the sample input of each baked template', () => {
    expect(templates.length).toBeGreaterThan(20);
    const dir = mkdtempSync(join(tmpdir(), 'passbook-types-'));
    try {
      const files: string[] = [];
      templates.forEach((m, i) => {
        const name = `${typeName(m.name)}${i}Input`;
        const text = inputTypeFile(m.inputs, name, { templateId: `t${i}`, template: m.name });
        const file = join(dir, `t${i}.ts`);
        writeFileSync(
          file,
          `${text}\nexport const check: ${name} = ${JSON.stringify(m.sample ?? {})};\n`,
        );
        files.push(file);
      });
      const program = ts.createProgram(files, {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        target: ts.ScriptTarget.ES2022,
        lib: ['lib.es2022.d.ts'],
        types: [],
      });
      const errors = ts
        .getPreEmitDiagnostics(program)
        .map(
          (d) =>
            `${d.file?.fileName.split('/').pop()}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`,
        );
      expect(errors).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('writes required fields without ?, optional with ?, keeps enums and labels', () => {
    const text = inputTypeFile(
      {
        type: 'object',
        required: ['name'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', 'x-label': 'Full name' },
          tier: { enum: ['gold', 'silver'], default: 'gold' },
          seats: { type: 'array', items: { type: 'integer' } },
          note: { type: ['string', 'null'] },
        },
      },
      'MemberInput',
      { templateId: 't1', template: 'Member' },
    );
    expect(text).toContain('export type MemberInput = {');
    expect(text).toContain('/** Full name */\n  name: string;');
    expect(text).toContain('/** Default "gold". */\n  tier?: "gold" | "silver";');
    expect(text).toContain('seats?: Array<number>;');
    expect(text).toContain('note?: string | null;');
    expect(text).not.toContain('[key: string]');
  });

  it('prints the type for a template through the CLI, or writes it to a file', async () => {
    const out: string[] = [];
    const written: Array<[string, string]> = [];
    const io = (extra: Partial<Parameters<typeof run>[1]> = {}) => ({
      env: { PASSBOOK_KEY: 'pb_test_x' },
      out: (l: string) => out.push(l),
      err: (l: string) => out.push(`ERR ${l}`),
      writeFile: async (p: string, t: string) => void written.push([p, t]),
      makeClient: () =>
        fakeApi(() => [], {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        }),
      ...extra,
    });
    expect(await run(['types', 'tpl_1'], io())).toBe(0);
    expect(out.join('\n')).toContain('export type EventTicketInput = {\n  name: string;\n};');
    expect(await run(['types', 'tpl_1', '--name', 'Mine', '--out', 'mine.ts'], io())).toBe(0);
    expect(written[0]?.[0]).toBe('mine.ts');
    expect(written[0]?.[1]).toContain('export type Mine = {');
  });

  it('explains a missing key, a missing id and an unknown command', async () => {
    const lines: string[] = [];
    const io = (env: Record<string, string>) => ({
      env,
      out: (l: string) => lines.push(l),
      err: (l: string) => lines.push(l),
      writeFile: async () => undefined,
      makeClient: () => fakeApi(() => []),
    });
    expect(await run(['types', 'x'], io({}))).toBe(1);
    expect(await run(['types'], io({ PASSBOOK_KEY: 'k' }))).toBe(1);
    expect(await run(['listen'], io({ PASSBOOK_KEY: 'k' }))).toBe(1);
    expect(await run(['nope'], io({ PASSBOOK_KEY: 'k' }))).toBe(1);
    expect(lines.join('\n')).toMatch(/PASSBOOK_KEY.*template id.*--forward-to.*Unknown command/s);
  });
});

describe('passbook passes', () => {
  const lines: string[] = [];
  const io = (env: Record<string, string>, extra: Partial<Parameters<typeof run>[1]> = {}) => ({
    env,
    out: (l: string) => lines.push(l),
    err: (l: string) => lines.push(`ERR ${l}`),
    writeFile: async () => undefined,
    readFile: async () => '{"templateId":"t1","input":{"a":"1"}}',
    readStdin: async () => '{"input":{"b":"2"}}',
    makeClient: () => fakeApi(() => []),
    ...extra,
  });
  const env = { PASSBOOK_KEY: 'pb_test_secret' };

  it('creates from a file with flags laid over it, passing the idempotency key', async () => {
    calls.length = 0;
    const code = await run(
      [
        'passes',
        'create',
        '--file',
        'p.json',
        '--set',
        'c=3',
        '--email',
        'a@b.co',
        '--idempotency-key',
        'k1',
      ],
      io(env),
    );
    expect(code).toBe(0);
    expect(calls[0]).toEqual({
      op: 'create',
      body: { templateId: 't1', input: { a: '1', c: '3' }, holderEmail: 'a@b.co' },
      options: { idempotencyKey: 'k1' },
    });
    expect(lines.join('\n')).toContain('"id": "pass_1"');
  });

  it('updates from stdin', async () => {
    calls.length = 0;
    expect(await run(['passes', 'update', 'p1', '--file', '-', '--notify'], io(env))).toBe(0);
    expect(calls[0]).toMatchObject({
      op: 'update',
      id: 'p1',
      body: { input: { b: '2' }, notify: true },
    });
  });

  it('prints the problem code and detail, never the key', async () => {
    lines.length = 0;
    const failing = io(env, {
      makeClient: () => ({
        ...fakeApi(() => []),
        passes: {
          create: async () => {
            throw Object.assign(new Error('x'), {
              code: 'VALIDATION',
              detail: 'input.name is required.',
            });
          },
          update: async () => ({}),
        },
      }),
    });
    expect(await run(['passes', 'create', '--template', 't1'], failing)).toBe(1);
    expect(lines).toEqual(['ERR VALIDATION: input.name is required.']);
    expect(lines.join('')).not.toContain('pb_test_secret');
  });

  it('explains missing pieces', async () => {
    lines.length = 0;
    expect(await run(['passes', 'create'], io(env, { readFile: async () => '{}' }))).toBe(1);
    expect(await run(['passes', 'update'], io(env))).toBe(1);
    expect(await run(['passes', 'update', 'p1'], io(env))).toBe(1);
    expect(
      await run(['passes', 'create', '--file', 'x'], io(env, { readFile: async () => 'nope' })),
    ).toBe(1);
    expect(lines.join('\n')).toMatch(/--template.*pass id.*needs a change.*not valid JSON/s);
  });
});

describe('versions', () => {
  it('match each package.json, and the CLI names itself in the User-Agent', async () => {
    const version = (p: string) =>
      (JSON.parse(readFileSync(resolve(root, p), 'utf8')) as { version: string }).version;
    expect(SDK_VERSION).toBe(version('sdk/typescript/package.json'));
    expect(CLI_VERSION).toBe(version('sdk/cli/package.json'));
    const go = /const Version = "([^"]+)"/.exec(
      readFileSync(resolve(root, 'sdk/go/core.go'), 'utf8'),
    )?.[1];
    expect(go).toBe(version('sdk/typescript/package.json'));
    const seen: Array<string | undefined> = [];
    await run(['passes', 'update', 'p1'], {
      env: { PASSBOOK_KEY: 'pbp_test_x' },
      out: () => {},
      err: () => {},
      writeFile: async () => {},
      makeClient: (o) => {
        seen.push(o.userAgent);
        return fakeApi(() => []);
      },
    });
    expect(seen).toEqual([`passbook-cli/${CLI_VERSION}`]);
  });
});
