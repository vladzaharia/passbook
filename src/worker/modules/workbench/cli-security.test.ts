import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeSession } from '../../../../test/helpers/index.ts';
import { bump } from '../../platform/counters.ts';
import { all, first } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { cliKit } from './cli-test-fixtures.ts';
import { BROWSER } from './workbench-test-fixtures.ts';

let t: Awaited<ReturnType<typeof cliKit>>;
beforeAll(async () => {
  t = await cliKit();
});
afterAll(() => vi.unstubAllGlobals());

const lookupId = async (browser: Record<string, string>, userCode: string, ip: string) =>
  ((await (await t.lookup(browser, userCode, ip)).json()) as { id: string }).id;

describe('L21: code misses', () => {
  it('locks the account at the 6th miss in 15 minutes', async () => {
    const m = await t.person();
    for (let i = 0; i < 5; i++)
      await expectProblem(
        await t.lookup(m.browser, 'BBBB-BBBB', t.fresh()),
        404,
        'CLI_CODE_NOT_FOUND',
      );
    await expectProblem(await t.lookup(m.browser, 'BBBB-BBBB', t.fresh()), 429, 'RATE_LIMITED');
    // The window turns over after 15 minutes.
    t.kit.clock.advance(15 * 60_000);
    await expectProblem(
      await t.lookup(m.browser, 'BBBB-BBBB', t.fresh()),
      404,
      'CLI_CODE_NOT_FOUND',
    );
  });

  it('locks a network prefix at the 21st miss in an hour', async () => {
    const m = await t.person();
    const ip = t.fresh();
    const hour = Math.floor(t.kit.clock.now() / 3_600_000) * 3_600_000;
    await bump(t.db, `cli.miss:p:${ip.replace(/\.\d+$/, '.0/24')}`, hour, 20);
    await expectProblem(await t.lookup(m.browser, 'BBBB-BBBB', ip), 429, 'RATE_LIMITED');
  });

  it('answers a miss, an expired code and a used code alike', async () => {
    const m = await t.person();
    const miss = await t.lookup(m.browser, 'CCCC-CCCC', t.fresh());
    const used = await t.started();
    const id = await lookupId(m.browser, used.userCode, used.ip);
    expect((await t.approve(m.browser, id, m.orgId, used.ip)).status).toBe(200);
    const again = await t.lookup(m.browser, used.userCode, used.ip);
    const expired = await t.started();
    t.kit.clock.advance(601_000);
    const gone = await t.lookup(m.browser, expired.userCode, expired.ip);
    const bodies = await Promise.all(
      [miss, gone, again].map(async (r) => {
        const { requestId: _r, ...rest } = (await r.json()) as Record<string, unknown>;
        return { status: r.status, ...rest };
      }),
    );
    expect(bodies[0]).toMatchObject({ status: 404, code: 'CLI_CODE_NOT_FOUND' });
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });

  it('counts a code typed wrong in shape as a miss', async () => {
    const m = await t.person();
    await expectProblem(await t.lookup(m.browser, 'nope', t.fresh()), 404, 'CLI_CODE_NOT_FOUND');
    const row = await first<{ count: number }>(
      t.db,
      'SELECT count FROM counters WHERE key = ? ORDER BY window_start DESC',
      [`cli.miss:u:${m.user.id}`],
    );
    expect(row?.count).toBe(1);
  });
});

describe('L22: approve needs a Polaris ID person with a recent sign-in', () => {
  it('refuses email-link and break-glass sessions', async () => {
    const m = await t.person();
    const s = await t.started();
    for (const amr of ['magic_link', 'breakglass'] as const) {
      const session = await makeSession(t.kit.f, {
        userId: m.user.id,
        roles: ['user', 'console'],
        amr,
      });
      const browser = { ...session.headers, ...BROWSER };
      await expectProblem(await t.lookup(browser, s.userCode, s.ip), 403, 'IDP_SIGN_IN_REQUIRED');
      await expectProblem(
        await t.approve(browser, 'any', m.orgId, s.ip),
        403,
        'IDP_SIGN_IN_REQUIRED',
      );
    }
  });

  it('asks for a step-up once the sign-in is older than 10 minutes', async () => {
    const m = await t.person();
    const s = await t.started();
    const id = await lookupId(m.browser, s.userCode, s.ip);
    const stale = await makeSession(t.kit.f, {
      userId: m.user.id,
      roles: ['user', 'console'],
      authTime: t.kit.clock.now() - 11 * 60_000,
    });
    const browser = { ...stale.headers, ...BROWSER };
    await expectProblem(await t.approve(browser, id, m.orgId, s.ip), 403, 'STEP_UP_REQUIRED');
    await expectProblem(await t.deny(browser, id, s.ip), 403, 'STEP_UP_REQUIRED');
    // The code is kept: the same session approves once it signs in again.
    expect((await t.approve(m.browser, id, m.orgId, s.ip)).status).toBe(200);
  });

  it('needs CSRF, and refuses a bearer', async () => {
    const m = await t.person();
    const s = await t.started();
    const id = await lookupId(m.browser, s.userCode, s.ip);
    const noCsrf = { cookie: m.session.headers.cookie ?? '', 'sec-fetch-site': 'cross-site' };
    expect((await t.approve(noCsrf, id, m.orgId, s.ip)).status).toBe(403);
    const { issued } = await t.signIn(m.browser, m.orgId);
    for (const token of [issued.token, 'pbtry_x.y', 'pbp_test_abcdefgh_x']) {
      const headers = { ...m.browser, authorization: `Bearer ${token}` };
      expect([401, 403]).toContain((await t.approve(headers, id, m.orgId, s.ip)).status);
      expect([401, 403]).toContain((await t.deny(headers, id, s.ip)).status);
    }
    expect((await t.approve(m.browser, id, m.orgId, s.ip)).status).toBe(200);
  });

  it('a sandbox needs the developer role and its owner; an org needs console access', async () => {
    const d = await t.sandbox();
    const plain = await makeSession(t.kit.f, { userId: d.user.id, roles: ['user'] });
    const s = await t.started();
    const id = await lookupId(d.browser, s.userCode, s.ip);
    await expectProblem(
      await t.approve({ ...plain.headers, ...BROWSER }, id, d.made.orgId, s.ip),
      403,
      'DEVELOPER_ACCESS_REQUIRED',
    );
    const stranger = await t.person();
    await expectProblem(
      await t.approve(stranger.browser, id, d.made.orgId, s.ip),
      404,
      'ORG_NOT_FOUND',
    );
    const m = await t.person();
    const noConsole = await makeSession(t.kit.f, { userId: m.user.id, roles: ['user'] });
    t.kit.env.OIDC_CONSOLE_GROUP_REQUIRED = 'true';
    try {
      await expectProblem(
        await t.approve({ ...noConsole.headers, ...BROWSER }, id, m.orgId, s.ip),
        403,
        'CONSOLE_ACCESS_REQUIRED',
      );
    } finally {
      t.kit.env.OIDC_CONSOLE_GROUP_REQUIRED = 'false';
    }
    // The refusals left the code pending.
    expect((await t.approve(d.browser, id, d.made.orgId, s.ip)).status).toBe(200);
  });

  it('warns when the approving network differs from the starting one', async () => {
    const m = await t.person();
    const s = await t.started();
    const there = await (await t.lookup(m.browser, s.userCode, t.fresh())).json();
    expect(there).toMatchObject({ mismatch: true });
    const same = await (await t.lookup(m.browser, s.userCode, s.ip)).json();
    expect(same).toMatchObject({ mismatch: false });
    const id = (same as { id: string }).id;
    expect((await t.approve(m.browser, id, m.orgId, t.fresh())).status).toBe(200);
    const audit = await all<{ detail: string }>(
      t.db,
      "SELECT detail FROM audit_log WHERE action = 'cli_session.approved' AND target_id = ?",
      [id],
    );
    expect(JSON.parse(audit[0]?.detail ?? '{}')).toMatchObject({ mismatch: true });
  });
});

describe('L23: account hint', () => {
  it('another account approving gets 409 CLI_ACCOUNT_MISMATCH and the session stays pending', async () => {
    const owner = await t.person();
    const other = await t.person();
    const s = await t.started(undefined, {
      client: { name: 'passbook-cli', version: '1', os: 'linux' },
      accountHint: owner.user.id,
    });
    const found = (await (await t.lookup(other.browser, s.userCode, s.ip)).json()) as {
      id: string;
      accountMismatch: boolean;
    };
    expect(found.accountMismatch).toBe(true);
    await expectProblem(
      await t.approve(other.browser, found.id, other.orgId, s.ip),
      409,
      'CLI_ACCOUNT_MISMATCH',
    );
    expect(
      await first(t.db, "SELECT 1 FROM audit_log WHERE action = 'cli_session.account_mismatch'"),
    ).not.toBeNull();
    expect((await t.approve(owner.browser, found.id, owner.orgId, s.ip)).status).toBe(200);
  });
});

describe('L24: one token, polls that slow down', () => {
  it('concurrent approves and concurrent polls hand over exactly one token', async () => {
    const m = await t.person();
    const s = await t.started();
    const id = await lookupId(m.browser, s.userCode, s.ip);
    const approves = await Promise.all(
      [1, 2, 3].map(() => t.approve(m.browser, id, m.orgId, s.ip)),
    );
    expect(approves.filter((r) => r.status === 200)).toHaveLength(1);
    const made = await all(
      t.db,
      "SELECT id FROM api_keys WHERE origin = 'cli' AND membership_id = ?",
      [m.membershipId],
    );
    expect(made).toHaveLength(1);
    const polls = await Promise.all([1, 2, 3].map(() => t.poll(s.deviceCode, s.ip)));
    expect(polls.filter((r) => r.status === 200)).toHaveLength(1);
    for (const r of polls.filter((r) => r.status !== 200))
      await expectProblem(r, 400, 'CLI_CODE_EXPIRED');
    await expectProblem(await t.poll(s.deviceCode, s.ip), 400, 'CLI_CODE_EXPIRED');
  });

  it('polls sooner than the interval get CLI_SLOW_DOWN, and the interval grows by 5 s', async () => {
    const s = await t.started();
    await expectProblem(await t.poll(s.deviceCode, s.ip), 400, 'CLI_AUTH_PENDING');
    await expectProblem(await t.poll(s.deviceCode, s.ip), 400, 'CLI_SLOW_DOWN');
    const hash = await sha256Hex(s.deviceCode);
    const interval = () =>
      first<{ interval_s: number }>(
        t.db,
        'SELECT interval_s FROM cli_sessions WHERE device_hash = ?',
        [hash],
      );
    expect((await interval())?.interval_s).toBe(10);
    t.kit.clock.advance(6_000);
    await expectProblem(await t.poll(s.deviceCode, s.ip), 400, 'CLI_SLOW_DOWN');
    expect((await interval())?.interval_s).toBe(15);
    t.kit.clock.advance(16_000);
    await expectProblem(await t.poll(s.deviceCode, s.ip), 400, 'CLI_AUTH_PENDING');
  });
});
