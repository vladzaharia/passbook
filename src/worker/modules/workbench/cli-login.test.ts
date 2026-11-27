import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { all, first, run } from '../../platform/db.ts';
import { CLIENT, cliKit } from './cli-test-fixtures.ts';

let t: Awaited<ReturnType<typeof cliKit>>;
beforeAll(async () => {
  t = await cliKit();
});
afterAll(() => vi.unstubAllGlobals());

describe('POST /cli/sessions', () => {
  it('answers codes, an absolute URI with no code in it, and no cache or CORS', async () => {
    const res = await t.start();
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(body.deviceCode).toMatch(/^[\w-]{43}$/);
    expect(body).toMatchObject({ expiresIn: 600, interval: 5 });
    expect(String(body.verificationUri)).toMatch(/^https?:\/\/[^?#]+\/workbench\/cli$/);
  });

  it('stores digests, never the codes', async () => {
    const s = await t.started();
    const rows = await all<Record<string, unknown>>(t.db, 'SELECT * FROM cli_sessions');
    const text = JSON.stringify(rows);
    expect(text).not.toContain(s.deviceCode);
    expect(text).not.toContain(s.userCode.replace('-', ''));
  });

  it('refuses unknown fields and over-long client fields', async () => {
    expect((await t.start(t.fresh(), { client: CLIENT, extra: 1 })).status).toBe(422);
    expect((await t.start(t.fresh(), { client: { ...CLIENT, name: 'x'.repeat(65) } })).status).toBe(
      422,
    );
  });

  it('limits starts to 10 an hour per network', async () => {
    const ip = '198.51.100.9';
    for (let i = 0; i < 4; i++) expect((await t.start(ip)).status).toBe(201);
    // The 60-second burst guard comes first (5 a minute); the hour counter holds the rest.
    await run(t.db, "UPDATE counters SET count = 10 WHERE key LIKE 'cli.start:198.51.100.%'");
    await expectProblem(await t.start(ip), 429, 'RATE_LIMITED');
  });

  it('answers 503 CLI_BUSY at 2,000 pending sessions', async () => {
    const now = t.kit.clock.now();
    await run(
      t.db,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
       INSERT INTO cli_sessions (id, device_hash, code_mac, client, created_at, expires_at)
       SELECT 'busy' || i, 'busy-d' || i, 'busy-c' || i, '{}', ?1, ?2 FROM n`,
      [now, now + 600_000],
    );
    await expectProblem(await t.start('192.0.2.50'), 503, 'CLI_BUSY');
    await run(t.db, "DELETE FROM cli_sessions WHERE id LIKE 'busy%'");
  });
});

describe('the device flow', () => {
  it('signs a sandbox in: typed code, approve, one token, Test only', async () => {
    const d = await t.sandbox();
    const s = await t.started();
    const pending = await t.poll(s.deviceCode);
    await expectProblem(pending, 400, 'CLI_AUTH_PENDING');
    // The person types it as they like: lower case, no dash, spaces.
    const typed = s.userCode.replace('-', ' ').toLowerCase();
    const found = await t.lookup(d.browser, typed, s.ip);
    expect(found.status, await found.clone().text()).toBe(200);
    const review = (await found.json()) as Record<string, unknown>;
    expect(review).toMatchObject({
      client: CLIENT,
      mismatch: false,
      accountMismatch: false,
      account: { id: d.user.id },
    });
    const ok = await t.approve(d.browser, review.id as string, d.made.orgId, s.ip);
    expect(ok.status, await ok.clone().text()).toBe(200);
    t.kit.clock.advance(6_000);
    const res = await t.poll(s.deviceCode);
    expect(res.status, await res.clone().text()).toBe(200);
    const token = (await res.json()) as Record<string, unknown>;
    expect(token.token).toMatch(/^pbcli_test_[\w-]{8}_[\w-]{43}$/);
    expect(token).toMatchObject({
      orgId: d.made.orgId,
      context: { kind: 'sandbox' },
      account: { email: d.user.primaryEmail },
    });
    expect(token.expiresAt).toBe(t.kit.clock.now() - 6_000 + 30 * 86_400_000);
    const key = await first<Record<string, unknown>>(t.db, 'SELECT * FROM api_keys WHERE id = ?', [
      String(token.tokenId),
    ]);
    expect(key).toMatchObject({
      origin: 'cli',
      kind: 'personal',
      mode: 'test',
      org_id: d.made.orgId,
    });
    expect(String(key?.key_hash)).not.toContain(String(token.token));
    // The token works on a route the CLI calls, and the second poll finds nothing.
    expect((await t.call('GET', '/passes', t.cli(String(token.token)))).status).toBe(200);
    await expectProblem(await t.poll(s.deviceCode), 400, 'CLI_CODE_EXPIRED');
  });

  it('signs a regular org member in', async () => {
    const m = await t.person();
    const { issued } = await t.signIn(m.browser, m.orgId);
    expect(issued.orgId).toBe(m.orgId);
    expect((await t.call('GET', '/passes', t.cli(issued.token))).status).toBe(200);
  });

  it('a denied session is terminal', async () => {
    const m = await t.person();
    const s = await t.started();
    const { id } = (await (await t.lookup(m.browser, s.userCode, s.ip)).json()) as { id: string };
    expect((await t.deny(m.browser, id, s.ip)).status).toBe(200);
    await expectProblem(await t.poll(s.deviceCode), 400, 'CLI_CODE_DENIED');
    await expectProblem(await t.approve(m.browser, id, m.orgId, s.ip), 404, 'CLI_CODE_NOT_FOUND');
  });

  it('an unknown or expired device code is CLI_CODE_EXPIRED', async () => {
    await expectProblem(await t.poll('x'.repeat(43)), 400, 'CLI_CODE_EXPIRED');
    const s = await t.started();
    t.kit.clock.advance(601_000);
    await expectProblem(await t.poll(s.deviceCode), 400, 'CLI_CODE_EXPIRED');
  });
});
