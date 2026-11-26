import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makePass, makeSession, makeTemplate } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { signWorkbenchToken, WORKBENCH_TOKEN_TTL_MS } from './token.ts';
import { BROWSER, bearer, workbenchKit } from './workbench-test-fixtures.ts';

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
  it('mints a sandbox_key token for your sandbox: Test, 15 minutes, works with no cookie', async () => {
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
    for (const claims of forged)
      expect(
        (await t.call('GET', '/passes', t.asClient(await signWorkbenchToken(t.kit.env, claims))))
          .status,
      ).toBe(401);
    const good = await signWorkbenchToken(t.kit.env, { ...forged[1], generation: 0 });
    expect((await t.call('GET', '/passes', t.asClient(good))).status).toBe(200);
    const [payload] = good.slice('pbtry_'.length).split('.');
    expect(
      (await t.call('GET', '/passes', bearer(`pbtry_${payload}.${'A'.repeat(43)}`))).status,
    ).toBe(401);
  });
});
