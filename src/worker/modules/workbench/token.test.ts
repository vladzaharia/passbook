import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makePass, makeSession, makeTemplate } from '../../../../test/helpers/index.ts';
import { all, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { signWorkbenchToken, WORKBENCH_TOKEN_TTL_MS } from './token.ts';
import { BROWSER, bearer, ORIGIN, workbenchKit } from './workbench-test-fixtures.ts';

let t: Awaited<ReturnType<typeof workbenchKit>>;
beforeAll(async () => {
  t = await workbenchKit();
});
afterAll(() => vi.unstubAllGlobals());

const passIn = async (orgId: string, mode: 'live' | 'test') => {
  const { resolved, registry } = makeTemplate({ id: `tpl-${orgId}`, orgId });
  return makePass(t.kit.f, { orgId, template: resolved, registry, mode });
};

describe('POST /workbench/token', () => {
  it('mints a sandbox_key token for your sandbox: Test, 15 minutes, beside its session cookie', async () => {
    const d = await t.developer();
    const minted = await t.wbMint(d.browser, d.made.orgId);
    expect(minted).toMatchObject({ orgId: d.made.orgId, mode: 'test', subject: 'sandbox_key' });
    expect(minted.token).toMatch(/^pbtry_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(minted.expiresAt).toBe(t.kit.clock.now() + WORKBENCH_TOKEN_TTL_MS);
    const me = await t.call('GET', '/api-keys/me', t.asClient(minted.token));
    expect(me.status, await me.clone().text()).toBe(200);
    expect(await me.json()).toMatchObject({ id: d.key.id, orgId: d.made.orgId, mode: 'test' });
    expect((await t.call('GET', '/passes', t.asClient(minted.token))).status).toBe(200);
  });

  it('mints a member token for a regular org: Test passes only, Live ids not found', async () => {
    const m = await t.member();
    const { token, subject } = await t.wbMint(m.browser, m.orgId);
    expect(subject).toBe('member');
    const test = await passIn(m.orgId, 'test');
    const live = await passIn(m.orgId, 'live');
    const list = await t.call('GET', '/passes', t.asClient(token));
    expect(list.status, await list.clone().text()).toBe(200);
    const ids = ((await list.json()) as { items: { id: string }[] }).items.map((p) => p.id);
    expect(ids).toContain(test.id);
    expect(ids).not.toContain(live.id);
    expect((await t.call('GET', `/passes/${test.id}`, t.asClient(token))).status).toBe(200);
    for (const [method, path] of [
      ['GET', `/passes/${live.id}`],
      ['GET', `/passes/${live.id}/events`],
      ['POST', `/passes/${live.id}/void`],
    ] as const)
      await expectProblem(await t.call(method, path, t.asClient(token), {}), 404, 'PASS_NOT_FOUND');
  });

  it('needs a session with CSRF, an org you belong to, and only your own sandbox', async () => {
    const m = await t.member();
    expect((await t.call('POST', '/workbench/token', BROWSER, { orgId: m.orgId })).status).toBe(
      401,
    );
    const noCsrf = { cookie: m.session.headers.cookie ?? '', 'sec-fetch-site': 'cross-site' };
    expect((await t.call('POST', '/workbench/token', noCsrf, { orgId: m.orgId })).status).toBe(403);
    const stranger = await t.member();
    await expectProblem(
      await t.call('POST', '/workbench/token', stranger.browser, { orgId: m.orgId }),
      404,
      'ORG_NOT_FOUND',
    );
    const d = await t.developer();
    const other = await t.developer();
    await expectProblem(
      await t.call('POST', '/workbench/token', other.browser, { orgId: d.made.orgId }),
      404,
      'ORG_NOT_FOUND',
    );
  });

  it('L9: a token never mints a token; the mint ignores a bearer', async () => {
    const m = await t.member();
    const { token } = await t.wbMint(m.browser, m.orgId);
    for (const path of ['/workbench/token', '/developer/try-token'])
      await expectProblem(
        await t.call('POST', path, t.asClient(token), { orgId: m.orgId }),
        401,
        'UNAUTHENTICATED',
      );
    await expectProblem(
      await t.call('DELETE', `/workbench/token?orgId=${m.orgId}`, t.asClient(token)),
      401,
      'UNAUTHENTICATED',
    );
  });
});

describe('L5: one org, one session', () => {
  it('a token for org A answers 404 on org B, by name or by id', async () => {
    const a = await t.member();
    const b = await t.member();
    // The same person is a member of B too: the token still reaches only A.
    await t.join(a.user.id, b.orgId, ['org_admin']);
    const { token } = await t.wbMint(a.browser, a.orgId);
    const theirs = await passIn(b.orgId, 'test');
    for (const path of [
      `/passes?orgId=${b.orgId}`,
      `/passes/${theirs.id}`,
      `/webhook-endpoints?orgId=${b.orgId}`,
      `/api-keys?orgId=${b.orgId}`,
      `/test-inbox?orgId=${b.orgId}`,
      `/events?orgId=${b.orgId}`,
    ])
      expect((await t.call('GET', path, t.asClient(token))).status, path).toBe(404);
    expect((await t.call('GET', `/passes?orgId=${a.orgId}`, t.asClient(token))).status).toBe(200);
  });

  it('a token never lists across organizations', async () => {
    const a = await t.member();
    const b = await t.member();
    await t.join(a.user.id, b.orgId, ['org_admin']);
    const { token } = await t.wbMint(a.browser, a.orgId);
    for (const q of [
      'orgId=all',
      'orgId=null',
      `orgId=all&orgIds=${b.orgId}`,
      'orgId=all&count=true',
    ])
      expect((await t.call('GET', `/passes?${q}`, t.asClient(token))).status, q).toBe(403);
    const d = await t.developer();
    const sandbox = await t.wbMint(d.browser, d.made.orgId);
    expect((await t.call('GET', '/passes?orgId=all', t.asClient(sandbox.token))).status).toBe(403);
  });

  it('stops after DELETE, sign-out, expiry, a removed membership, or beside another session', async () => {
    const ended = await t.member();
    const first = await t.wbMint(ended.browser, ended.orgId);
    const res = await t.call('DELETE', `/workbench/token?orgId=${ended.orgId}`, ended.browser);
    expect(res.status, await res.clone().text()).toBe(200);
    await expectProblem(
      await t.call('GET', '/passes', t.asClient(first.token)),
      401,
      'INVALID_API_KEY',
    );
    const again = await t.wbMint(ended.browser, ended.orgId);
    expect((await t.call('GET', '/passes', t.asClient(again.token))).status).toBe(200);

    const out = await t.member();
    const signedOut = await t.wbMint(out.browser, out.orgId);
    await run(t.kit.env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
      t.kit.clock.now(),
      await sha256Hex(out.session.cookieValue),
    ]);
    expect((await t.call('GET', '/passes', t.asClient(signedOut.token))).status).toBe(401);

    const removed = await t.member();
    const r = await t.wbMint(removed.browser, removed.orgId);
    await run(t.kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      t.kit.clock.now(),
      removed.membershipId,
    ]);
    expect((await t.call('GET', '/passes', t.asClient(r.token))).status).toBe(401);

    const late = await t.member();
    const l = await t.wbMint(late.browser, late.orgId);
    const other = await makeSession(t.kit.f, { userId: late.user.id, roles: ['user', 'console'] });
    expect(
      (
        await t.call('GET', '/passes', {
          ...t.asClient(l.token),
          cookie: other.headers.cookie ?? '',
        })
      ).status,
    ).toBe(401);
    t.kit.clock.advance(WORKBENCH_TOKEN_TTL_MS);
    expect((await t.call('GET', '/passes', t.asClient(l.token))).status).toBe(401);
  });

  it('refuses a forged or altered token', async () => {
    const m = await t.member();
    const sessionIdHash = await sha256Hex(m.session.cookieValue);
    const expiresAt = t.kit.clock.now() + WORKBENCH_TOKEN_TTL_MS;
    const other = await t.member();
    const forged = [
      // Another org's membership under this session.
      {
        subject: 'member',
        orgId: other.orgId,
        ref: other.membershipId,
        sessionIdHash,
        generation: 0,
        expiresAt,
      },
      // A generation the session never had.
      {
        subject: 'member',
        orgId: m.orgId,
        ref: m.membershipId,
        sessionIdHash,
        generation: 3,
        expiresAt,
      },
      // The member subject on a membership id of the right org but someone else's session.
      {
        subject: 'member',
        orgId: m.orgId,
        ref: m.membershipId,
        sessionIdHash: await sha256Hex(other.session.cookieValue),
        generation: 0,
        expiresAt,
      },
    ] as const;
    // Each beside the cookie of the session it names, so only the forged binding fails.
    const cookies = [m, m, other].map((p) => p.session.headers.cookie ?? '');
    for (const [i, claims] of forged.entries()) {
      const token = await signWorkbenchToken(t.kit.env, claims);
      const res = await t.call('GET', '/passes', { ...t.bare(token), cookie: cookies[i] ?? '' });
      expect(res.status, `forged ${i}`).toBe(401);
    }
    const good = await signWorkbenchToken(t.kit.env, { ...forged[1], generation: 0 });
    const page = { ...t.bare(good), cookie: cookies[0] ?? '' };
    expect((await t.call('GET', '/passes', page)).status).toBe(200);
    const [payload] = good.slice('pbtry_'.length).split('.');
    expect(
      (await t.call('GET', '/passes', bearer(`pbtry_${payload}.${'A'.repeat(43)}`))).status,
    ).toBe(401);
  });
});

describe('M1: a v2 token is bound to its browser session', () => {
  it('copied off the page (no cookie) it is 401, for both subjects', async () => {
    const m = await t.member();
    const member = await t.wbMint(m.browser, m.orgId);
    const d = await t.developer();
    const sandbox = await t.wbMint(d.browser, d.made.orgId);
    for (const { token } of [member, sandbox]) {
      expect((await t.call('GET', '/passes', t.asClient(token))).status).toBe(200);
      await expectProblem(await t.call('GET', '/passes', t.bare(token)), 401, 'INVALID_API_KEY');
      // A server call: no browser signals at all.
      await expectProblem(await t.call('GET', '/passes', bearer(token)), 401, 'INVALID_API_KEY');
    }
  });

  it('with a token present the cookie never decides: a dead token beside a live cookie is 401', async () => {
    const m = await t.member();
    const { token } = await t.wbMint(m.browser, m.orgId);
    expect((await t.call('DELETE', `/workbench/token?orgId=${m.orgId}`, m.browser)).status).toBe(
      200,
    );
    await expectProblem(
      await t.call('GET', `/passes?orgId=${m.orgId}`, t.asClient(token)),
      401,
      'INVALID_API_KEY',
    );
    // A cookie-only (human) route answers 401 too while a token rides along, even a good one.
    const fresh = await t.wbMint(m.browser, m.orgId);
    await expectProblem(
      await t.call('GET', '/developer/access', { ...m.browser, ...bearer(fresh.token) }),
      401,
      'UNAUTHENTICATED',
    );
    expect((await t.call('GET', '/developer/access', m.browser)).status).toBe(200);
  });

  it('a pbtry_ token that does not parse never falls back to the cookie', async () => {
    const m = await t.member();
    const { token } = await t.wbMint(m.browser, m.orgId);
    const headers = [
      'Bearer pbtry_broken',
      `Bearer ${token} x`,
      `bearer ${token.slice(0, -1)}`,
      `Bearer ${token} Bearer ${token}`,
      token,
    ];
    for (const authorization of headers) {
      for (const path of ['/passes', '/developer/access']) {
        const res = await t.call('GET', path, { ...m.browser, authorization });
        expect(res.status, `${path} ${authorization.slice(0, 20)}`).toBe(401);
      }
    }
  });

  it('the request log keeps no Authorization: a logged token call holds no part of the token', async () => {
    const d = await t.developer();
    const { token } = await t.wbMint(d.browser, d.made.orgId);
    const pending: Promise<unknown>[] = [];
    const ectx = {
      waitUntil: (p: Promise<unknown>) => void pending.push(p),
      passThroughOnException() {},
    } as unknown as ExecutionContext;
    const res = await t.app.request(
      `${ORIGIN}/api/v1/passes?limit=1`,
      { headers: t.asClient(token) },
      t.kit.env,
      ectx,
    );
    expect(res.status).toBe(200);
    await Promise.all(pending);
    const rows = await all<Record<string, unknown>>(
      t.kit.env.DB,
      'SELECT * FROM request_log WHERE org_id = ?',
      [d.made.orgId],
    );
    expect(rows.length).toBeGreaterThan(0);
    const [, mac = ''] = token.split('.');
    for (const row of rows) {
      const text = JSON.stringify(row);
      expect(text).not.toContain('pbtry_');
      expect(text).not.toContain(mac);
    }
  });
});
