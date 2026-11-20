import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeApiKey, makeOrg, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { CreatedDeveloperSandboxSchema, TryTokenSchema } from '../../../shared/contracts/index.ts';
import { createApp } from '../../app.ts';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createAuthStores } from '../../stores.ts';
import { type BlueprintKit, blueprintKit } from '../templates/blueprint-test-fixtures.ts';
import { signTryToken, TRY_TOKEN_TTL_MS } from './try-token.ts';

const ORIGIN = 'https://wallet.test';
/** What a browser sends with every fetch from the portal page. */
const BROWSER = { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' };

let kit: BlueprintKit;
let app: ReturnType<typeof createApp>;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  kit = await blueprintKit();
  kit.env.TURNSTILE_SECRET = '1x0000000000000000000000000000000AA';
  app = createApp({ stores: createAuthStores(kit.env, kit.clock), clock: kit.clock });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new Request(input, init).url;
    if (url.startsWith('https://challenges.cloudflare.com/'))
      return Response.json({ success: true });
    return realFetch(input, init);
  });
});
afterAll(() => vi.unstubAllGlobals());

const send = (method: string, path: string, headers: Record<string, string>) =>
  app.request(`${ORIGIN}/api/v1${path}`, { method, headers }, kit.env);

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** A person with a sandbox and a signed-in browser session (cookie, CSRF, Origin). */
async function developer() {
  const user = await makeUser(kit.f);
  const session = await makeSession(kit.f, { userId: user.id });
  const browser = { ...session.headers, ...BROWSER };
  const res = await app.request(
    `${ORIGIN}/api/v1/developer/sandbox`,
    {
      method: 'POST',
      headers: { ...browser, 'content-type': 'application/json' },
      body: JSON.stringify({ turnstileToken: 'ok' }),
    },
    kit.env,
  );
  expect(res.status, await res.clone().text()).toBe(201);
  const made = CreatedDeveloperSandboxSchema.parse(await res.json());
  if (!made.key) throw new Error('A new sandbox returns its key.');
  return { user, session, browser, made, key: made.key };
}

async function mint(browser: Record<string, string>) {
  const res = await send('POST', '/developer/try-token', browser);
  expect(res.status, await res.clone().text()).toBe(201);
  expect(res.headers.get('cache-control')).toBe('no-store');
  return TryTokenSchema.parse(await res.json());
}

/** The token from the portal page: browser signals and the session cookie ride along. */
const fromPage = (browser: Record<string, string>, token: string) => ({
  ...browser,
  ...bearer(token),
});

describe('POST /developer/try-token', () => {
  it('mints a 15-minute pbtry_ token that acts as the sandbox key, in Test, from the browser', async () => {
    const d = await developer();
    const { token, expiresAt } = await mint(d.browser);
    expect(token).toMatch(/^pbtry_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(expiresAt).toBe(kit.clock.now() + TRY_TOKEN_TTL_MS);

    const me = await send('GET', '/api-keys/me', fromPage(d.browser, token));
    expect(me.status, await me.clone().text()).toBe(200);
    expect(await me.json()).toMatchObject({ id: d.key.id, orgId: d.made.orgId, mode: 'test' });
    expect((await send('GET', '/passes', fromPage(d.browser, token))).status).toBe(200);
  });

  it('needs a signed-in person and the CSRF check', async () => {
    const d = await developer();
    expect((await send('POST', '/developer/try-token', BROWSER)).status).toBe(401);
    const noCsrf = { cookie: d.session.headers.cookie ?? '', 'sec-fetch-site': 'cross-site' };
    expect((await send('POST', '/developer/try-token', noCsrf)).status).toBe(403);
    const other = await makeSession(kit.f, { userId: (await makeUser(kit.f)).id });
    await expectProblem(
      await send('POST', '/developer/try-token', { ...other.headers, ...BROWSER }),
      404,
      'SANDBOX_NOT_FOUND',
    );
  });

  it('refuses when the sandbox key is gone, and the old token stops', async () => {
    const d = await developer();
    const { token } = await mint(d.browser);
    await run(kit.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      d.key.id,
    ]);
    expect((await send('GET', '/passes', fromPage(d.browser, token))).status).toBe(401);
    await expectProblem(
      await send('POST', '/developer/try-token', d.browser),
      409,
      'SANDBOX_KEY_MISSING',
    );
  });

  it('answers 429 over RL_API_TRY', async () => {
    const d = await developer();
    const saved = kit.env.RL_API_TRY;
    kit.env.RL_API_TRY = { limit: async () => ({ success: false }) } as unknown as RateLimit;
    try {
      expect((await send('POST', '/developer/try-token', d.browser)).status).toBe(429);
    } finally {
      kit.env.RL_API_TRY = saved;
    }
  });
});

describe('try token revocation', () => {
  it('stops at sign-out', async () => {
    const d = await developer();
    const { token } = await mint(d.browser);
    const out = await app.request(
      `${ORIGIN}/auth/logout`,
      { method: 'POST', headers: d.browser },
      kit.env,
    );
    expect(out.status).toBe(303);
    await expectProblem(await send('GET', '/passes', bearer(token)), 401, 'INVALID_API_KEY');
  });

  it('stops when the session is revoked from another session', async () => {
    const d = await developer();
    const { token } = await mint(d.browser);
    const phone = await makeSession(kit.f, { userId: d.user.id });
    const idHash = await sha256Hex(d.session.cookieValue);
    const res = await send('DELETE', `/me/sessions/${idHash}`, { ...phone.headers, ...BROWSER });
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await send('GET', '/passes', bearer(token))).status).toBe(401);
  });

  it('stops at a generation bump; a new token works', async () => {
    const d = await developer();
    const { token } = await mint(d.browser);
    expect((await send('DELETE', '/developer/try-token', bearer(token))).status).toBe(401);
    const res = await send('DELETE', '/developer/try-token', d.browser);
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await send('GET', '/passes', bearer(token))).status).toBe(401);
    const fresh = await mint(d.browser);
    expect((await send('GET', '/passes', bearer(fresh.token))).status).toBe(200);
    const audit = await first<{ n: number }>(
      kit.env.DB,
      "SELECT count(*) AS n FROM audit_log WHERE org_id = ? AND action = 'developer_sandbox.try_revoke'",
      [d.made.orgId],
    );
    expect(audit?.n).toBe(1);
  });

  it('stops when the sandbox closes', async () => {
    const d = await developer();
    const { token } = await mint(d.browser);
    expect((await send('DELETE', '/developer/sandbox', d.browser)).status).toBe(200);
    expect((await send('GET', '/passes', bearer(token))).status).toBe(401);
  });

  it('stops at expiry', async () => {
    const d = await developer();
    const { token, expiresAt } = await mint(d.browser);
    kit.clock.set(expiresAt - 1);
    expect((await send('GET', '/passes', bearer(token))).status).toBe(200);
    kit.clock.set(expiresAt);
    expect((await send('GET', '/passes', bearer(token))).status).toBe(401);
  });
});

describe('try token reach', () => {
  it('is refused by human-only routes, which never take a bearer', async () => {
    const d = await developer();
    const { token } = await mint(d.browser);
    for (const [method, path] of [
      ['GET', '/developer/sandbox'],
      ['POST', '/developer/try-token'],
      ['GET', '/me/passes'],
    ] as const)
      await expectProblem(
        await send(method, path, { ...BROWSER, ...bearer(token) }),
        401,
        'UNAUTHENTICATED',
      );
  });

  it('never reaches Live or another org', async () => {
    const d = await developer();
    const { token } = await mint(d.browser);
    const other = await developer();
    const own = await send('GET', `/templates/${d.made.templateId}`, bearer(token));
    expect(own.status, await own.clone().text()).toBe(200);
    const theirs = await send('GET', `/templates/${other.made.templateId}`, bearer(token));
    expect([403, 404]).toContain(theirs.status);
    // The mode header does not move a key: the key's row decides, and it is Test.
    const me = await send('GET', '/api-keys/me', { ...bearer(token), 'x-passbook-mode': 'live' });
    expect(await me.json()).toMatchObject({ mode: 'test', orgId: d.made.orgId });
  });

  it('resolves only a sandbox Test key of the same person and a live session', async () => {
    const d = await developer();
    const exp = kit.clock.now() + TRY_TOKEN_TTL_MS;
    const sessionIdHash = await sha256Hex(d.session.cookieValue);
    const org = await makeOrg(kit.f);
    const live = await makeApiKey(kit.f, { orgId: org.id, scopes: ['passes:read'] });
    const stranger = await makeSession(kit.f, { userId: (await makeUser(kit.f)).id });
    const forged = [
      // A correctly MAC'd token naming a live key of a standard org.
      { keyId: live.id, sessionIdHash, generation: 1, expiresAt: exp },
      // Someone else's session.
      {
        keyId: d.key.id,
        sessionIdHash: await sha256Hex(stranger.cookieValue),
        generation: 1,
        expiresAt: exp,
      },
      // A generation the sandbox never had.
      { keyId: d.key.id, sessionIdHash, generation: 2, expiresAt: exp },
    ];
    for (const claims of forged)
      expect(
        (await send('GET', '/passes', bearer(await signTryToken(kit.env, claims)))).status,
      ).toBe(401);
    const good = await signTryToken(kit.env, {
      keyId: d.key.id,
      sessionIdHash,
      generation: 1,
      expiresAt: exp,
    });
    expect((await send('GET', '/passes', bearer(good))).status).toBe(200);
    const [payload] = good.slice('pbtry_'.length).split('.');
    expect(
      (await send('GET', '/passes', bearer(`pbtry_${payload}.${'A'.repeat(43)}`))).status,
    ).toBe(401);
  });
});

describe('KEY_IN_BROWSER', () => {
  it('refuses any other key sent with a browser signal, and the same key from a server works', async () => {
    const org = await makeOrg(kit.f);
    const key = await makeApiKey(kit.f, { orgId: org.id, scopes: ['passes:read'] });
    const signals: Record<string, string>[] = [
      { origin: 'https://evil.example' },
      { origin: ORIGIN },
      { 'sec-fetch-site': 'same-origin' },
      { 'sec-fetch-site': 'none' },
      { cookie: '__Host-wallet_sid=x' },
    ];
    for (const signal of signals)
      await expectProblem(
        await send('GET', '/passes', { ...key.headers, ...signal }),
        403,
        'KEY_IN_BROWSER',
      );
    // Node's fetch sends sec-fetch-mode; cookie-jar clients echo Cloudflare's cookies. Neither is a browser.
    const server = { 'sec-fetch-mode': 'cors', 'user-agent': 'node', cookie: '__cf_bm=abc' };
    expect((await send('GET', '/passes', { ...key.headers, ...server })).status).toBe(200);
    expect((await send('GET', '/passes', key.headers)).status).toBe(200);
    // Every key guard: the key's own description too.
    await expectProblem(
      await send('GET', '/api-keys/me', { ...key.headers, ...BROWSER }),
      403,
      'KEY_IN_BROWSER',
    );
  });

  it('refuses the sandbox key itself in a browser: only the try token works there', async () => {
    const d = await developer();
    const key = bearer(d.key.secret);
    await expectProblem(
      await send('GET', '/passes', { ...BROWSER, ...key }),
      403,
      'KEY_IN_BROWSER',
    );
    expect((await send('GET', '/passes', key)).status).toBe(200);
  });
});
