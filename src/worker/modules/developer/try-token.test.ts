import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeApiKey, makeOrg, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { KEY_IN_BROWSER_CUTOFF } from '../../platform/browser-signals.ts';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { signTryToken, TRY_TOKEN_TTL_MS } from './try-token.ts';
import { BROWSER, bearer, fromPage, ORIGIN, page, tryKit } from './try-token-test-fixtures.ts';

let t: Awaited<ReturnType<typeof tryKit>>;
beforeAll(async () => {
  t = await tryKit();
});
afterAll(() => vi.unstubAllGlobals());
const send = (...args: Parameters<typeof t.send>) => t.send(...args);
const developer = () => t.developer();
const mint = (browser: Record<string, string>) => t.mint(browser);

describe('POST /developer/try-token', () => {
  it('mints a 15-minute pbtry_ token that acts as the sandbox key, in Test, from the browser', async () => {
    const d = await developer();
    const { token, expiresAt } = await mint(d.browser);
    expect(token).toMatch(/^pbtry_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(expiresAt).toBe(t.kit.clock.now() + TRY_TOKEN_TTL_MS);

    const me = await send('GET', '/api-keys/me', fromPage(d.browser, token));
    expect(me.status, await me.clone().text()).toBe(200);
    expect(await me.json()).toMatchObject({ id: d.key.id, orgId: d.made.orgId, mode: 'test' });
    expect((await send('GET', '/passes', fromPage(d.browser, token))).status).toBe(200);
  });

  it('is made from the sandbox key, not from a newer key with fewer scopes', async () => {
    const d = await developer();
    const res = await t.app.request(
      `${ORIGIN}/api/v1/api-keys`,
      {
        method: 'POST',
        headers: {
          ...d.browser,
          'content-type': 'application/json',
          'x-passbook-mode': 'test',
          'idempotency-key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          orgId: d.made.orgId,
          name: 'Narrow',
          scopes: ['passes:read', 'passes:write', 'templates:read'],
          expiresAt: t.kit.clock.now() + 20 * 86_400_000,
          kind: 'personal',
          mode: 'test',
        }),
      },
      t.kit.env,
    );
    expect(res.status, await res.clone().text()).toBe(201);
    const { token } = await mint(d.browser);
    // The token acts as the sandbox key: Webhooks and Logs still work, which the narrow key could not do.
    const me = await send('GET', '/api-keys/me', fromPage(d.browser, token));
    expect(await me.json()).toMatchObject({ id: d.key.id });
    expect((await send('GET', '/webhook-endpoints', fromPage(d.browser, token))).status).toBe(200);
    expect((await send('GET', '/passes', fromPage(d.browser, token))).status).toBe(200);
  });

  it('refuses when the only key left is a narrow one', async () => {
    const d = await developer();
    await run(t.kit.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
      t.kit.clock.now(),
      d.key.id,
    ]);
    const made = await t.app.request(
      `${ORIGIN}/api/v1/api-keys`,
      {
        method: 'POST',
        headers: {
          ...d.browser,
          'content-type': 'application/json',
          'x-passbook-mode': 'test',
          'idempotency-key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          orgId: d.made.orgId,
          name: 'Narrow',
          scopes: ['passes:read'],
          expiresAt: t.kit.clock.now() + 20 * 86_400_000,
          kind: 'personal',
          mode: 'test',
        }),
      },
      t.kit.env,
    );
    expect(made.status, await made.clone().text()).toBe(201);
    await expectProblem(
      await send('POST', '/developer/try-token', d.browser),
      409,
      'SANDBOX_KEY_MISSING',
    );
  });

  it('needs a signed-in person and the CSRF check', async () => {
    const d = await developer();
    expect((await send('POST', '/developer/try-token', BROWSER)).status).toBe(401);
    const noCsrf = { cookie: d.session.headers.cookie ?? '', 'sec-fetch-site': 'cross-site' };
    expect((await send('POST', '/developer/try-token', noCsrf)).status).toBe(403);
    const other = await makeSession(t.kit.f, {
      userId: (await makeUser(t.kit.f)).id,
      roles: ['user', 'developer'],
    });
    await expectProblem(
      await send('POST', '/developer/try-token', { ...other.headers, ...BROWSER }),
      404,
      'SANDBOX_NOT_FOUND',
    );
  });

  it('refuses when the sandbox key is gone, and the old token stops', async () => {
    const d = await developer();
    const { token } = await mint(d.browser);
    await run(t.kit.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
      t.kit.clock.now(),
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
    const saved = t.kit.env.RL_API_TRY;
    t.kit.env.RL_API_TRY = { limit: async () => ({ success: false }) } as unknown as RateLimit;
    try {
      expect((await send('POST', '/developer/try-token', d.browser)).status).toBe(429);
    } finally {
      t.kit.env.RL_API_TRY = saved;
    }
  });
});

describe('RL_API_TRY charges', () => {
  it('spends one call of the try budget per request, on the request log too', async () => {
    const d = await developer();
    const { token } = await mint(d.browser);
    const saved = t.kit.env.RL_API_TRY;
    const limit = vi.fn(async () => ({ success: true }));
    t.kit.env.RL_API_TRY = { limit } as unknown as RateLimit;
    try {
      for (const path of ['/developer/logs?source=key', '/developer/logs/missing', '/passes']) {
        limit.mockClear();
        await send('GET', path, fromPage(d.browser, token));
        expect(limit, path).toHaveBeenCalledTimes(1);
      }
    } finally {
      t.kit.env.RL_API_TRY = saved;
    }
  });
});

describe('try token revocation', () => {
  it('stops at sign-out', async () => {
    const d = await developer();
    const { token } = await mint(d.browser);
    const out = await t.app.request(
      `${ORIGIN}/auth/logout`,
      { method: 'POST', headers: d.browser },
      t.kit.env,
    );
    expect(out.status).toBe(303);
    await expectProblem(await send('GET', '/passes', page(d, token)), 401, 'INVALID_API_KEY');
  });

  it('stops when the session is revoked from another session', async () => {
    const d = await developer();
    const { token } = await mint(d.browser);
    const phone = await makeSession(t.kit.f, { userId: d.user.id, roles: ['user', 'developer'] });
    const idHash = await sha256Hex(d.session.cookieValue);
    const res = await send('DELETE', `/me/sessions/${idHash}`, { ...phone.headers, ...BROWSER });
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await send('GET', '/passes', page(d, token))).status).toBe(401);
  });

  it('stops at a generation bump; a new token works', async () => {
    const d = await developer();
    const { token } = await mint(d.browser);
    expect((await send('DELETE', '/developer/try-token', bearer(token))).status).toBe(401);
    const res = await send('DELETE', '/developer/try-token', d.browser);
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await send('GET', '/passes', page(d, token))).status).toBe(401);
    const fresh = await mint(d.browser);
    expect((await send('GET', '/passes', page(d, fresh.token))).status).toBe(200);
    const audit = await first<{ n: number }>(
      t.kit.env.DB,
      "SELECT count(*) AS n FROM audit_log WHERE org_id = ? AND action = 'developer_sandbox.try_revoke'",
      [d.made.orgId],
    );
    expect(audit?.n).toBe(1);
  });

  it('stops when the sandbox closes', async () => {
    const d = await developer();
    const { token } = await mint(d.browser);
    expect((await send('POST', '/developer/sandbox/close', d.browser)).status).toBe(200);
    expect((await send('GET', '/passes', page(d, token))).status).toBe(401);
  });

  it('stops at expiry', async () => {
    const d = await developer();
    const { token, expiresAt } = await mint(d.browser);
    t.kit.clock.set(expiresAt - 1);
    expect((await send('GET', '/passes', page(d, token))).status).toBe(200);
    t.kit.clock.set(expiresAt);
    expect((await send('GET', '/passes', page(d, token))).status).toBe(401);
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
    const own = await send('GET', `/templates/${d.made.templateId}`, page(d, token));
    expect(own.status, await own.clone().text()).toBe(200);
    const theirs = await send('GET', `/templates/${other.made.templateId}`, page(d, token));
    expect([403, 404]).toContain(theirs.status);
    // A token never serves Live: asked for it, it refuses (WORKBENCH_TEST_ONLY), and otherwise it is Test.
    const live = await send('GET', '/api-keys/me', {
      ...page(d, token),
      'x-passbook-mode': 'live',
    });
    await expectProblem(live, 403, 'WORKBENCH_TEST_ONLY');
    const me = await send('GET', '/api-keys/me', page(d, token));
    expect(await me.json()).toMatchObject({ mode: 'test', orgId: d.made.orgId });
  });

  it('is Test only, in the sandbox org only, whatever mode a caller asks for', async () => {
    const d = await developer();
    const { token } = await mint(d.browser);
    const asked = { ...page(d, token), 'x-passbook-mode': 'live' };
    // Every key the token can list is a Test key of the sandbox org, with the mode asked by header or by query.
    for (const [path, headers] of [
      [`/api-keys?orgId=${d.made.orgId}`, asked],
      [`/api-keys?orgId=${d.made.orgId}&mode=live`, asked],
      [`/api-keys?orgId=${d.made.orgId}&mode=live`, page(d, token)],
    ] as const) {
      const res = await send('GET', path, headers);
      if (res.status !== 200) {
        expect([400, 403, 409], path).toContain(res.status);
        continue;
      }
      const keys = ((await res.json()) as { items: { mode: string; orgId: string }[] }).items;
      expect(keys.length, path).toBeGreaterThan(0);
      for (const k of keys) expect(k, path).toMatchObject({ mode: 'test', orgId: d.made.orgId });
    }
    // It cannot mint a Live key in the sandbox, nor a key in another org.
    const mintKey = (orgId: string, mode: string) =>
      t.app.request(
        `${ORIGIN}/api/v1/api-keys`,
        {
          method: 'POST',
          headers: {
            ...asked,
            'content-type': 'application/json',
            'idempotency-key': crypto.randomUUID(),
          },
          body: JSON.stringify({
            orgId,
            name: 'x',
            scopes: ['passes:read'],
            expiresAt: t.kit.clock.now() + 86_400_000,
            kind: 'personal',
            mode,
          }),
        },
        t.kit.env,
      );
    const live = await mintKey(d.made.orgId, 'live');
    expect(live.status, await live.clone().text()).toBeGreaterThanOrEqual(400);
    const other = await developer();
    const foreign = await mintKey(other.made.orgId, 'test');
    expect(foreign.status, await foreign.clone().text()).toBeGreaterThanOrEqual(400);
    // Passes read in Live mode answer from Test rows or refuse: never a Live row.
    const pass = await send('GET', '/passes?mode=live', asked);
    if (pass.status === 200)
      for (const row of ((await pass.json()) as { items: { mode?: string }[] }).items)
        expect(row.mode ?? 'test').toBe('test');
  });

  it('resolves only a sandbox Test key of the same person and a live session', async () => {
    const d = await developer();
    const exp = t.kit.clock.now() + TRY_TOKEN_TTL_MS;
    const sessionIdHash = await sha256Hex(d.session.cookieValue);
    const org = await makeOrg(t.kit.f);
    const live = await makeApiKey(t.kit.f, { orgId: org.id, scopes: ['passes:read'] });
    const stranger = await makeSession(t.kit.f, { userId: (await makeUser(t.kit.f)).id });
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
    // The stranger's own cookie with a token naming their session: the session is not the sandbox person's.
    const theirs = await signTryToken(t.kit.env, forged[1] as (typeof forged)[number]);
    expect(
      (await send('GET', '/passes', { cookie: stranger.headers.cookie ?? '', ...bearer(theirs) }))
        .status,
    ).toBe(401);
    for (const claims of forged)
      expect(
        (await send('GET', '/passes', page(d, await signTryToken(t.kit.env, claims)))).status,
      ).toBe(401);
    const good = await signTryToken(t.kit.env, {
      keyId: d.key.id,
      sessionIdHash,
      generation: 1,
      expiresAt: exp,
    });
    expect((await send('GET', '/passes', page(d, good))).status).toBe(200);
    const [payload] = good.slice('pbtry_'.length).split('.');
    expect(
      (await send('GET', '/passes', page(d, `pbtry_${payload}.${'A'.repeat(43)}`))).status,
    ).toBe(401);
  });
});

describe('KEY_IN_BROWSER', () => {
  it('refuses a sandbox key made after the cutoff in a browser: only the try token works there', async () => {
    t.kit.clock.set(Math.max(t.kit.clock.now(), KEY_IN_BROWSER_CUTOFF));
    const d = await developer();
    const key = bearer(d.key.secret);
    await expectProblem(
      await send('GET', '/passes', { ...BROWSER, ...key }),
      403,
      'KEY_IN_BROWSER',
    );
    expect((await send('GET', '/passes', key)).status).toBe(200);
    const { token } = await mint(d.browser);
    expect((await send('GET', '/passes', fromPage(d.browser, token))).status).toBe(200);
  });
});
