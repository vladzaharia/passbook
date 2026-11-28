import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Api } from '../sdk/cli/src/api.ts';
import { run } from '../sdk/cli/src/cli.ts';
import { memoryStore, type Profile } from '../sdk/cli/src/credentials.ts';
import { credentialsPath, fileStore } from '../sdk/cli/src/credentials-file.ts';
import { type Exec, keychainStore } from '../sdk/cli/src/credentials-keychain.ts';
import { openTarget } from '../sdk/cli/src/open.ts';

const ORIGIN = 'https://passbook.mobile';
const TOKEN = `pbcli_test_abcdefgh_${'x'.repeat(43)}`;
const profile = (over: Partial<Profile> = {}): Profile => ({
  origin: ORIGIN,
  token: TOKEN,
  tokenId: 'key1',
  orgId: 'org1',
  context: { kind: 'sandbox', name: 'Dev sandbox' },
  account: { id: 'u1', name: 'Ada', email: 'ada@example.com' },
  expiresAt: 10_000_000,
  ...over,
});

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** A fake server: answers by `METHOD path`, records every request. */
function server(answers: Record<string, Array<Response | (() => Response)>>) {
  const sent: Sent[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    sent.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    });
    const next = answers[key]?.shift();
    if (!next) return new Response(JSON.stringify({ code: 'NOT_FOUND' }), { status: 404 });
    return typeof next === 'function' ? next() : next;
  }) as typeof fetch;
  return { sent, fetcher };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const started = {
  deviceCode: 'd'.repeat(43),
  userCode: 'BCDF-GHJK',
  verificationUri: `${ORIGIN}/workbench/cli`,
  expiresIn: 600,
  interval: 5,
};
const issued = {
  token: TOKEN,
  tokenId: 'key1',
  orgId: 'org1',
  context: { kind: 'sandbox', name: 'Dev sandbox' },
  account: { id: 'u1', name: 'Ada', email: 'ada@example.com' },
  expiresAt: 10_000_000,
  origin: ORIGIN,
};

function harness(
  answers: Record<string, Array<Response | (() => Response)>>,
  env: Record<string, string | undefined> = {},
  store = memoryStore(),
) {
  const out: string[] = [];
  const err: string[] = [];
  const opened: string[] = [];
  const made: Array<{ apiKey: string; baseUrl?: string }> = [];
  let clock = 1_000_000;
  const srv = server(answers);
  const api = { passes: { list: async () => ({ items: [] }) } } as unknown as Api;
  const io = {
    env,
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
    writeFile: async () => undefined,
    makeClient: (o: { apiKey: string; baseUrl?: string }) => {
      made.push(o);
      return api;
    },
    credentials: store,
    openBrowser: async (u: string) => void opened.push(u),
    sleep: async (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    os: 'macOS',
    fetch: srv.fetcher,
  };
  const exec = (argv: string[]) => run(argv, io);
  return { exec, out, err, opened, made, sent: srv.sent, store };
}

describe('passbook login', () => {
  it('prints the code and the page, opens the page without the code, and keeps the token without printing it', async () => {
    const h = harness({
      'POST /api/v1/cli/sessions': [json(201, started)],
      'POST /api/v1/cli/sessions/token': [
        json(400, { code: 'CLI_AUTH_PENDING' }),
        json(400, { code: 'CLI_SLOW_DOWN' }),
        json(200, issued),
      ],
    });
    expect(await h.exec(['login'])).toBe(0);
    expect(h.out).toEqual([
      `Open ${ORIGIN}/workbench/cli and enter the code: BCDF-GHJK`,
      'Check the code matches before you approve.',
      'Signed in as ada@example.com to Dev sandbox (Test).',
    ]);
    // The page, never the code, and nothing printed carries the token.
    expect(h.opened).toEqual([`${ORIGIN}/workbench/cli`]);
    expect([...h.out, ...h.err, ...h.opened].join('\n')).not.toContain('pbcli_');
    expect((await h.store.get(ORIGIN))?.token).toBe(TOKEN);
    // The device code is in the body, never a query string; the first call carries no account hint.
    const polls = h.sent.filter((s) => s.url.endsWith('/token'));
    expect(polls.map((p) => JSON.parse(p.body ?? '{}'))).toEqual(
      polls.map(() => ({ deviceCode: started.deviceCode })),
    );
    expect(h.sent.every((s) => !s.url.includes('?'))).toBe(true);
    expect(JSON.parse(h.sent[0]?.body ?? '{}')).toEqual({
      client: { name: 'passbook-cli', version: '0.2.0', os: 'macOS' },
    });
  });

  it('sends the stored account as a hint, unless --switch', async () => {
    const store = memoryStore([profile()]);
    const hint = harness({ 'POST /api/v1/cli/sessions': [json(500, {})] }, {}, store);
    await hint.exec(['login']);
    expect(JSON.parse(hint.sent[0]?.body ?? '{}')).toMatchObject({ accountHint: 'u1' });
    const sw = harness({ 'POST /api/v1/cli/sessions': [json(500, {})] }, {}, store);
    await sw.exec(['login', '--switch', '--no-browser']);
    expect(JSON.parse(sw.sent[0]?.body ?? '{}')).not.toHaveProperty('accountHint');
  });

  it.each([
    ['CLI_CODE_DENIED', 'The sign-in was denied.'],
    ['CLI_CODE_EXPIRED', 'The code expired. Run passbook login again.'],
    [
      'CLI_ACCOUNT_MISMATCH',
      'Approved by a different account. Run `passbook login --switch` to change accounts.',
    ],
  ])('ends on %s with its sentence', async (code, line) => {
    const h = harness({
      'POST /api/v1/cli/sessions': [json(201, started)],
      'POST /api/v1/cli/sessions/token': [json(400, { code })],
    });
    expect(await h.exec(['login', '--no-browser'])).toBe(1);
    expect(h.err).toEqual([line]);
    expect(h.opened).toEqual([]);
  });

  it('refuses a token for another origin and keeps nothing', async () => {
    const h = harness({
      'POST /api/v1/cli/sessions': [json(201, started)],
      'POST /api/v1/cli/sessions/token': [json(200, { ...issued, origin: 'https://evil.example' })],
    });
    expect(await h.exec(['login'])).toBe(1);
    expect(h.err.join()).toContain('another origin');
    expect(h.store.all.size).toBe(0);
  });

  it('refuses a verification page on another origin', async () => {
    const h = harness({
      'POST /api/v1/cli/sessions': [
        json(201, { ...started, verificationUri: 'https://evil.example/workbench/cli' }),
      ],
    });
    expect(await h.exec(['login'])).toBe(1);
    expect(h.opened).toEqual([]);
  });

  it('stops after the code expires', async () => {
    const h = harness({
      'POST /api/v1/cli/sessions': [json(201, { ...started, expiresIn: 10 })],
      'POST /api/v1/cli/sessions/token': [
        json(400, { code: 'CLI_AUTH_PENDING' }),
        json(400, { code: 'CLI_AUTH_PENDING' }),
        json(400, { code: 'CLI_AUTH_PENDING' }),
      ],
    });
    expect(await h.exec(['login', '--no-browser'])).toBe(1);
    expect(h.err).toEqual(['The code expired. Run passbook login again.']);
  });
});

describe('passbook logout', () => {
  it('ends the token with its own bearer, then forgets it', async () => {
    const h = harness(
      { 'DELETE /api/v1/cli/tokens/key1': [json(200, { ok: true })] },
      {},
      memoryStore([profile()]),
    );
    expect(await h.exec(['logout'])).toBe(0);
    expect(h.sent[0]).toMatchObject({
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(h.out).toEqual(['Signed out.']);
    expect(h.store.all.size).toBe(0);
  });

  it('forgets it even when the server is unreachable, and says so', async () => {
    const store = memoryStore([profile()]);
    const out: string[] = [];
    const code = await run(['logout'], {
      env: {},
      out: (l) => out.push(l),
      err: () => undefined,
      writeFile: async () => undefined,
      makeClient: () => ({}) as Api,
      credentials: store,
      fetch: (async () => {
        throw new Error('offline');
      }) as typeof fetch,
    });
    expect(code).toBe(0);
    expect(out[0]).toContain('could not be reached');
    expect(store.all.size).toBe(0);
  });

  it('says so when there is nothing to end', async () => {
    const h = harness({});
    expect(await h.exec(['logout'])).toBe(0);
    expect(h.out).toEqual(['Not signed in.']);
  });
});

describe('L28: a stored token goes only where it was issued', () => {
  it('uses the stored token for its own origin, and PASSBOOK_KEY wins', async () => {
    const key = harness({}, { PASSBOOK_KEY: 'pbp_test_abcdefgh_k' }, memoryStore([profile()]));
    await key.exec(['trigger', 'installed']).catch(() => undefined);
    expect(key.made[0]?.apiKey).toBe('pbp_test_abcdefgh_k');
    const signed = harness({}, {}, memoryStore([profile()]));
    await signed.exec(['trigger', 'installed']);
    expect(signed.made[0]).toEqual({
      apiKey: TOKEN,
      baseUrl: ORIGIN,
      userAgent: 'passbook-cli/0.2.0',
    });
  });

  it('sends no stored token to another PASSBOOK_BASE_URL origin, and says why', async () => {
    const h = harness(
      {},
      { PASSBOOK_BASE_URL: 'https://attacker.example/x' },
      memoryStore([profile()]),
    );
    expect(await h.exec(['trigger', 'installed'])).toBe(1);
    expect(h.made).toEqual([]);
    expect(h.err[0]).toContain('is not sent there');
    expect(h.sent).toEqual([]);
  });

  it('a record stored under one origin is never read for another', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pbcli-'));
    try {
      const store = fileStore(join(dir, 'c.json'));
      await store.set(profile());
      expect(await store.get('https://attacker.example')).toBeNull();
      expect((await store.get(ORIGIN))?.token).toBe(TOKEN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an expired sign-in is not sent: log in again', async () => {
    const h = harness({}, {}, memoryStore([profile({ expiresAt: 5 })]));
    expect(await h.exec(['trigger', 'installed'])).toBe(1);
    expect(h.err).toEqual(['Your sign-in expired. Run passbook login.']);
  });

  it('keeps the credentials file at 0600 in a 0700 folder, never the working directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pbcli-'));
    try {
      const path = credentialsPath({ XDG_CONFIG_HOME: dir });
      expect(path).toBe(join(dir, 'passbook', 'credentials.json'));
      const store = fileStore(path);
      await store.set(profile());
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'passbook')).mode & 0o777).toBe(0o700);
      expect(JSON.parse(readFileSync(path, 'utf8'))[ORIGIN].token).toBe(TOKEN);
      await store.delete(ORIGIN);
      expect(await store.get(ORIGIN)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the macOS keychain gets the secret on stdin, never in the arguments', async () => {
    const calls: Array<{ file: string; args: string[]; stdin?: string | undefined }> = [];
    const exec: Exec = async (file, args, stdin) => {
      calls.push({ file, args, stdin });
      return { code: 0, stdout: '' };
    };
    await keychainStore('darwin', exec)?.set(profile());
    expect(calls[0]?.args).toEqual(['-i']);
    expect(calls[0]?.args.join(' ')).not.toContain(TOKEN);
    expect(calls[0]?.stdin).toMatch(
      /^add-generic-password -U -s passbook-cli -a "https:\/\/passbook\.mobile" -w [\w-]+\n$/,
    );
    expect(keychainStore('win32', exec)).toBeNull();
  });
});

describe('passbook open', () => {
  it('opens a tool of the profile org as a plain URL: no token, code or query', async () => {
    const h = harness({}, {}, memoryStore([profile()]));
    expect(await h.exec(['open', 'logs'])).toBe(0);
    expect(h.opened).toEqual([`${ORIGIN}/workbench/o/org1/logs`]);
    expect(h.sent).toEqual([]);
    expect(h.opened[0]).not.toMatch(/[?#]|pbcli/);
    h.opened.length = 0;
    await h.exec(['open']);
    expect(h.opened).toEqual([`${ORIGIN}/workbench/o/org1`]);
  });

  it('asks the server where an id opens, with the bearer, and opens only what is on its origin', async () => {
    const h = harness(
      {
        'GET /api/v1/resolve': [
          json(200, { kind: 'pass', href: '/workbench/o/org1/passes?p=abc' }),
        ],
      },
      {},
      memoryStore([profile()]),
    );
    expect(await h.exec(['open', 'abc'])).toBe(0);
    expect(h.sent[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(h.opened).toEqual([`${ORIGIN}/workbench/o/org1/passes?p=abc`]);
  });

  it('refuses an off-origin or off-prefix href, and an id the server does not know', async () => {
    for (const href of [
      'https://evil.example/workbench/o/org1',
      '//evil.example/workbench',
      '/auth/oidc/start?next=/admin',
      '/workbenchx/o',
      'javascript:alert(1)',
      'https://user:pw@passbook.mobile/workbench',
    ])
      expect(openTarget(href, ORIGIN), href).toBeNull();
    expect(openTarget('/admin/passes', ORIGIN)).toBe(`${ORIGIN}/admin/passes`);
    expect(openTarget('/developers/logs#x', ORIGIN)).toBe(`${ORIGIN}/developers/logs#x`);
    const h = harness(
      { 'GET /api/v1/resolve': [json(200, { href: 'https://evil.example/workbench' })] },
      {},
      memoryStore([profile()]),
    );
    expect(await h.exec(['open', 'abc'])).toBe(1);
    expect(h.opened).toEqual([]);
    const missing = harness(
      { 'GET /api/v1/resolve': [json(404, {})] },
      {},
      memoryStore([profile()]),
    );
    expect(await missing.exec(['open', 'abc'])).toBe(1);
  });

  it('needs a sign-in', async () => {
    const h = harness({});
    expect(await h.exec(['open', 'logs'])).toBe(1);
    expect(h.err).toEqual(['Not signed in. Run passbook login.']);
  });
});
