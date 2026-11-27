import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makePass, makeSession, makeTemplate, makeUser } from '../../../../test/helpers/index.ts';
import { CLI_LOGOUT_ROUTE, CLI_ROUTES } from '../../../shared/contracts/cli.ts';
import { WORKBENCH_ROUTES } from '../../../shared/contracts/workbench.ts';
import { all, first, run } from '../../platform/db.ts';
import { redact, redactString } from '../../platform/log.ts';
import { requireStepUp } from '../../platform/sign-in-guard.ts';
import { cliKit } from './cli-test-fixtures.ts';
import { WORKBENCH_NEVER } from './inventory.ts';
import { BROWSER, ORIGIN } from './workbench-test-fixtures.ts';

let t: Awaited<ReturnType<typeof cliKit>>;
beforeAll(async () => {
  t = await cliKit();
});
afterAll(() => vi.unstubAllGlobals());

const keyCount = async (orgId: string) =>
  (await first<{ n: number }>(t.db, 'SELECT count(*) AS n FROM api_keys WHERE org_id = ?', [orgId]))
    ?.n;

describe('the CLI route list', () => {
  it('is a subset of the Workbench list (its logout aside) and holds no never-route', () => {
    for (const route of CLI_ROUTES) {
      expect(WORKBENCH_ROUTES, route).toContain(route);
      for (const [never, why] of WORKBENCH_NEVER)
        expect(never.test(route), `${route}: ${why}`).toBe(false);
      expect(route).not.toMatch(/\/api-keys|\/cli\/|\/workbench\/token|device-passes/);
    }
    expect(CLI_LOGOUT_ROUTE).toBe('DELETE /api/v1/cli/tokens/:id');
  });
});

describe('L25: a CLI token', () => {
  it('works on its routes in Test, and refuses Live, other orgs and other routes', async () => {
    const m = await t.person();
    const { issued } = await t.signIn(m.browser, m.orgId);
    const cli = t.cli(issued.token);
    const { resolved, registry } = makeTemplate({ id: `tpl-${m.orgId}`, orgId: m.orgId });
    const own = await makePass(t.kit.f, {
      orgId: m.orgId,
      template: resolved,
      registry,
      mode: 'test',
    });
    expect((await t.call('GET', `/passes/${own.id}`, cli)).status).toBe(200);
    // Live: refused, even with a Test key.
    await expectProblem(
      await t.call('GET', '/passes', { ...cli, 'x-passbook-mode': 'live' }),
      403,
      'WORKBENCH_TEST_ONLY',
    );
    // Another org's pass: not found.
    const other = await t.person();
    const tpl = makeTemplate({ id: `tpl-${other.orgId}`, orgId: other.orgId });
    const theirs = await makePass(t.kit.f, {
      orgId: other.orgId,
      template: tpl.resolved,
      registry: tpl.registry,
      mode: 'test',
    });
    await expectProblem(await t.call('GET', `/passes/${theirs.id}`, cli), 404, 'PASS_NOT_FOUND');
    // A route outside the list.
    for (const [method, path] of [
      ['GET', '/webhook-endpoints'],
      ['GET', '/api-keys/me'],
      ['GET', '/orgs'],
      ['POST', `/passes/${own.id}/void`],
      ['POST', '/templates/x/release'],
      ['GET', '/audit'],
    ] as const)
      await expectProblem(await t.call(method, path, cli, {}), 403, 'CLI_TOKEN_NOT_ALLOWED');
  });

  it('cannot make a key: POST /api-keys is 403 and nothing is made', async () => {
    const m = await t.person();
    const { issued } = await t.signIn(m.browser, m.orgId);
    const before = await keyCount(m.orgId);
    for (const [method, path, body] of [
      [
        'POST',
        '/api-keys',
        {
          orgId: m.orgId,
          name: 'x',
          scopes: ['passes:read'],
          mode: 'test',
          kind: 'personal',
          expiresAt: t.kit.clock.now() + 86_400_000,
        },
      ],
      ['GET', `/api-keys?orgId=${m.orgId}`, undefined],
      ['POST', `/api-keys/${issued.tokenId}/rotate`, { orgId: m.orgId }],
      ['DELETE', `/api-keys/${issued.tokenId}?orgId=${m.orgId}`, undefined],
    ] as const)
      await expectProblem(
        await t.call(method, path, t.cli(issued.token), body),
        403,
        'CLI_TOKEN_NOT_ALLOWED',
      );
    expect(await keyCount(m.orgId)).toBe(before);
  });

  it('holds the Test data scopes of its member, and logs:read', async () => {
    const m = await t.person();
    const { issued } = await t.signIn(m.browser, m.orgId);
    const row = await first<{ scopes: string; mode: string }>(
      t.db,
      'SELECT scopes, mode FROM api_keys WHERE id = ?',
      [issued.tokenId],
    );
    const scopes = JSON.parse(row?.scopes ?? '[]') as string[];
    expect(scopes).toContain('logs:read');
    expect(scopes).not.toContain('api-keys:write');
    expect(row?.mode).toBe('test');
    expect((await t.call('GET', '/request-logs', t.cli(issued.token))).status).toBe(200);
    expect(
      (await t.call('GET', '/resolve?id=019e0000-0000-7000-8000-000000000000', t.cli(issued.token)))
        .status,
    ).toBe(404);
  });

  it('a step-up route refuses it outright', async () => {
    const next = vi.fn();
    const c = { var: { auth: { kind: 'api_key', via: 'cli' } } };
    await expect(requireStepUp(600)(c as never, next)).rejects.toMatchObject({
      code: 'CLI_TOKEN_NOT_ALLOWED',
    });
    expect(next).not.toHaveBeenCalled();
  });
});

describe('L9: no bearer approves, mints a token or makes a CLI session', () => {
  it('refuses a pbtry_, pbcli_ and key bearer on /workbench/token and the approve and deny routes', async () => {
    const m = await t.person();
    const { issued } = await t.signIn(m.browser, m.orgId);
    const { token: tryToken } = await t.wbMint(m.browser, m.orgId);
    const s = await t.started();
    for (const token of [issued.token, tryToken]) {
      const headers = { ...m.browser, authorization: `Bearer ${token}` };
      for (const [path, body] of [
        ['/workbench/token', { orgId: m.orgId }],
        [`/cli/sessions/x/approve`, { orgId: m.orgId }],
        [`/cli/sessions/x/deny`, {}],
        ['/cli/sessions/lookup', { userCode: s.userCode }],
      ] as const) {
        const res = await t.call('POST', path, headers, body);
        expect([401, 403], `${path}: ${res.status}`).toContain(res.status);
      }
      // And a bare bearer on the CLI routes the CLI never calls.
      expect(
        (await t.call('POST', '/cli/sessions/lookup', t.cli(token), { userCode: s.userCode }))
          .status,
      ).toBe(401);
    }
  });
});

describe('L26: a CLI token stops', () => {
  const dead = async (token: string) =>
    expectProblem(await t.call('GET', '/passes', t.cli(token)), 401, 'INVALID_API_KEY');
  const live = async (token: string) =>
    expect((await t.call('GET', '/passes', t.cli(token))).status).toBe(200);

  it('after Revoke in Keys, and after logout (its own id only)', async () => {
    const m = await t.person();
    const a = (await t.signIn(m.browser, m.orgId)).issued;
    const b = (await t.signIn(m.browser, m.orgId)).issued;
    const revoke = await t.call('DELETE', `/api-keys/${a.tokenId}?orgId=${m.orgId}`, m.browser);
    expect(revoke.status, await revoke.clone().text()).toBe(200);
    await dead(a.token);
    await live(b.token);
    // Logout ends the token itself; another token's id is not found.
    await expectProblem(
      await t.call('DELETE', `/cli/tokens/${a.tokenId}`, t.cli(b.token)),
      404,
      'NOT_FOUND',
    );
    const out = await t.call('DELETE', `/cli/tokens/${b.tokenId}`, t.cli(b.token));
    expect(out.status, await out.clone().text()).toBe(200);
    await dead(b.token);
    const row = await first<{ revoked_at: number | null }>(
      t.db,
      'SELECT revoked_at FROM api_keys WHERE id = ?',
      [b.tokenId],
    );
    expect(row?.revoked_at).not.toBeNull();
    const audit = await all<{ detail: string }>(
      t.db,
      "SELECT detail FROM audit_log WHERE action = 'cli_token.revoked' AND target_id = ?",
      [b.tokenId],
    );
    expect(JSON.parse(audit[0]?.detail ?? '{}')).toMatchObject({ reason: 'logout', by: 'device' });
  });

  it('after a sign-out everywhere', async () => {
    const m = await t.person();
    const { issued } = await t.signIn(m.browser, m.orgId);
    const res = await t.app.request(
      `${ORIGIN}/auth/logout?all=1`,
      { method: 'POST', headers: { ...m.browser, accept: 'application/json' } },
      t.kit.env,
    );
    expect(res.status, await res.clone().text()).toBeLessThan(400);
    await dead(issued.token);
  });

  it('after the membership is revoked or the user is disabled', async () => {
    const m = await t.person();
    const a = (await t.signIn(m.browser, m.orgId)).issued;
    await live(a.token);
    await run(t.db, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      t.kit.clock.now(),
      m.membershipId,
    ]);
    await dead(a.token);
    const n = await t.person();
    const b = (await t.signIn(n.browser, n.orgId)).issued;
    await run(t.db, "UPDATE users SET status = 'disabled' WHERE id = ?", [n.user.id]);
    await dead(b.token);
  });

  it('after a sign-in that drops the developer group (sandbox), or the console group (org)', async () => {
    const d = await t.sandbox();
    const a = (await t.signIn(d.browser, d.made.orgId)).issued;
    await live(a.token);
    await t.roles(d.user.id, ['user']);
    await dead(a.token);
    const m = await t.person();
    const b = (await t.signIn(m.browser, m.orgId)).issued;
    t.kit.env.OIDC_CONSOLE_GROUP_REQUIRED = 'true';
    try {
      await live(b.token);
      await t.roles(m.user.id, ['user']);
      await dead(b.token);
    } finally {
      t.kit.env.OIDC_CONSOLE_GROUP_REQUIRED = 'false';
    }
  });

  it('after a sandbox reset or close', async () => {
    const d = await t.sandbox();
    const a = (await t.signIn(d.browser, d.made.orgId)).issued;
    const { endCliTokensOf } = await import('./cli-revoke.ts');
    await endCliTokensOf(
      { env: t.kit.env, clock: t.kit.clock } as never,
      { orgId: d.made.orgId },
      'sandbox_reset',
    );
    await dead(a.token);
    const e = await t.sandbox();
    const b = (await t.signIn(e.browser, e.made.orgId)).issued;
    await run(
      t.db,
      "UPDATE developer_sandboxes SET closed_at = ?, close_reason = 'user' WHERE org_id = ?",
      [t.kit.clock.now(), e.made.orgId],
    );
    await dead(b.token);
  });

  it('after 7 days idle', async () => {
    const m = await t.person();
    const { issued } = await t.signIn(m.browser, m.orgId);
    t.kit.clock.advance(6 * 86_400_000);
    await live(issued.token);
    t.kit.clock.advance(7 * 86_400_000 + 1000);
    await dead(issued.token);
    const row = await first<{ token_revoke_reason: string }>(
      t.db,
      'SELECT token_revoke_reason FROM cli_sessions WHERE token_id = ?',
      [issued.tokenId],
    );
    expect(row?.token_revoke_reason).toBe('idle');
  });

  it('after 30 days, however often it is used', async () => {
    const m = await t.person();
    const { issued } = await t.signIn(m.browser, m.orgId);
    for (let i = 0; i < 4; i++) {
      t.kit.clock.advance(6 * 86_400_000);
      await live(issued.token);
    }
    t.kit.clock.advance(6 * 86_400_000);
    await dead(issued.token);
  });

  it('after the kill switch, for a platform admin with a recent Polaris ID sign-in only', async () => {
    const m = await t.person();
    const a = (await t.signIn(m.browser, m.orgId)).issued;
    await expectProblem(
      await t.call('POST', '/platform/cli-tokens/revoke', m.browser, { orgId: m.orgId }),
      403,
      'FORBIDDEN',
    );
    const admin = await makeUser(t.kit.f);
    const session = await makeSession(t.kit.f, { userId: admin.id, roles: ['admin', 'user'] });
    const res = await t.call(
      'POST',
      '/platform/cli-tokens/revoke',
      { ...session.headers, ...BROWSER },
      { orgId: m.orgId },
    );
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ revoked: 1 });
    await dead(a.token);
  });

  it('the sixth live token of a person ends the oldest', async () => {
    const m = await t.person();
    const tokens = [];
    for (let i = 0; i < 6; i++) tokens.push((await t.signIn(m.browser, m.orgId)).issued);
    await dead(tokens[0]?.token ?? '');
    for (const next of tokens.slice(1)) await live(next.token);
  });
});

describe('L27: redaction', () => {
  it('hides pbcli_ values and the code keys in logs', () => {
    expect(redactString('Bearer pbcli_test_abcdefgh_' + 'x'.repeat(43))).not.toContain(
      'pbcli_test',
    );
    expect(redactString('x pbcli_test_abcdefgh_yyyy z')).toBe('x pbcli_[redacted] z');
    expect(
      redact({
        deviceCode: 'abc',
        userCode: 'BCDF-GHJK',
        user_code: 'x',
        device_code: 'y',
        keep: 1,
      }),
    ).toEqual({
      deviceCode: '[redacted]',
      userCode: '[redacted]',
      user_code: '[redacted]',
      device_code: '[redacted]',
      keep: 1,
    });
  });

  it('audit and the request log hold no token or code', async () => {
    const m = await t.person();
    const s = await t.started();
    const { issued } = await t.signIn(m.browser, m.orgId);
    await t.call('GET', '/passes', t.cli(issued.token));
    const text = JSON.stringify([
      await all(t.db, 'SELECT * FROM audit_log'),
      await all(t.db, 'SELECT * FROM request_log'),
    ]);
    for (const secret of [
      issued.token,
      issued.token.split('_').at(-1),
      s.deviceCode,
      s.userCode,
      s.userCode.replace('-', ''),
    ])
      expect(text, String(secret)).not.toContain(String(secret));
    expect(text).not.toContain('pbcli_test_');
  });
});
