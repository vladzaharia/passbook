import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/worker/app.ts';
import {
  KEY_IN_BROWSER_CUTOFF,
  KEY_IN_BROWSER_REPORT_MS,
  KEY_IN_BROWSER_WARNING_HEADER,
} from '../../src/worker/platform/browser-signals.ts';
import { ManualClock } from '../../src/worker/platform/clock.ts';
import { first } from '../../src/worker/platform/db.ts';
import type { AppEnv } from '../../src/worker/platform/env.ts';
import { createAuthStores } from '../../src/worker/stores.ts';
import {
  expectProblem,
  type Fixtures,
  fixtures,
  makeApiKey,
  makeEnv,
  makeOrg,
} from '../helpers/index.ts';

const ORIGIN = 'https://wallet.test';
const BROWSER = { origin: ORIGIN, 'sec-fetch-site': 'same-origin' };

let env: AppEnv;
let clock: ManualClock;
let f: Fixtures;
let app: ReturnType<typeof createApp>;
let orgId: string;

beforeAll(async () => {
  clock = new ManualClock(KEY_IN_BROWSER_CUTOFF);
  env = await makeEnv();
  f = fixtures(env, clock);
  orgId = (await makeOrg(f)).id;
  app = createApp({ stores: createAuthStores(env, clock), clock });
});
afterEach(() => vi.restoreAllMocks());

const get = (path: string, headers: Record<string, string>) =>
  app.request(`${ORIGIN}/api/v1${path}`, { headers }, env);

const prefixOf = async (id: string) =>
  (await first<{ prefix: string }>(env.DB, 'SELECT prefix FROM api_keys WHERE id = ?', [id]))
    ?.prefix;

/** A key made at `at`; the clock then stands at `now`. */
async function keyAt(at: number, now = at) {
  clock.set(at);
  const key = await makeApiKey(f, { orgId, scopes: ['passes:read'] });
  clock.set(now);
  return key;
}

describe('KEY_IN_BROWSER for a key made from the cutoff on', () => {
  it('refuses the key with any browser signal, and the same key from a server works', async () => {
    const key = await keyAt(KEY_IN_BROWSER_CUTOFF);
    const signals: Record<string, string>[] = [
      { origin: 'https://evil.example' },
      { origin: ORIGIN },
      { 'sec-fetch-site': 'same-origin' },
      { 'sec-fetch-site': 'none' },
      { cookie: '__Host-wallet_sid=x' },
    ];
    for (const signal of signals)
      await expectProblem(
        await get('/passes', { ...key.headers, ...signal }),
        403,
        'KEY_IN_BROWSER',
      );
    // Node's fetch sends sec-fetch-mode; cookie-jar clients echo Cloudflare's cookies. Neither is a browser.
    const server = { 'sec-fetch-mode': 'cors', 'user-agent': 'node', cookie: '__cf_bm=abc' };
    const ok = await get('/passes', { ...key.headers, ...server });
    expect(ok.status).toBe(200);
    expect(ok.headers.get(KEY_IN_BROWSER_WARNING_HEADER)).toBeNull();
    // Every key guard: the key's own description too, and a bearer that is not a key at all.
    await expectProblem(
      await get('/api-keys/me', { ...key.headers, ...BROWSER }),
      403,
      'KEY_IN_BROWSER',
    );
    await expectProblem(
      await get('/passes', { authorization: 'Bearer nonsense', ...BROWSER }),
      403,
      'KEY_IN_BROWSER',
    );
  });

  it('logs the refusal with the org and the key prefix, never the secret', async () => {
    const key = await keyAt(KEY_IN_BROWSER_CUTOFF + 1);
    const lines: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((line: string) => void lines.push(line));
    await get('/passes', { ...key.headers, ...BROWSER });
    const refusal = lines.map((l) => JSON.parse(l)).find((l) => l.code === 'KEY_IN_BROWSER');
    expect(refusal).toMatchObject({ orgId, keyPrefix: await prefixOf(key.id) });
    expect(lines.join('\n')).not.toContain(key.secret);
  });
});

describe('KEY_IN_BROWSER report-only for a key made before the cutoff', () => {
  it('lets the call through with a warning header for 30 days, then refuses it', async () => {
    const key = await keyAt(KEY_IN_BROWSER_CUTOFF - 1, KEY_IN_BROWSER_CUTOFF + 1);
    const lines: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((line: string) => void lines.push(line));
    const seen = await get('/passes', { ...key.headers, ...BROWSER });
    expect(seen.status).toBe(200);
    expect(seen.headers.get(KEY_IN_BROWSER_WARNING_HEADER)).toMatch(/^KEY_IN_BROWSER: /);
    expect(seen.headers.get('retry-after')).toBeNull();
    const logged = lines.map((l) => JSON.parse(l)).find((l) => l.code === 'KEY_IN_BROWSER_SEEN');
    expect(logged).toMatchObject({ orgId, keyPrefix: await prefixOf(key.id) });
    expect(lines.join('\n')).not.toContain(key.secret);
    // A wrong secret with that key's prefix gains nothing: it is still not a key.
    const forged = `${key.secret.slice(0, -1)}${key.secret.endsWith('A') ? 'B' : 'A'}`;
    await expectProblem(
      await get('/passes', { authorization: `Bearer ${forged}`, ...BROWSER }),
      401,
      'INVALID_API_KEY',
    );

    clock.set(KEY_IN_BROWSER_CUTOFF + KEY_IN_BROWSER_REPORT_MS);
    await expectProblem(
      await get('/passes', { ...key.headers, ...BROWSER }),
      403,
      'KEY_IN_BROWSER',
    );
    expect((await get('/passes', key.headers)).status).toBe(200);
  });
});
