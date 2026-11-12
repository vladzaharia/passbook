import type { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  countD1,
  fakeRateLimiter,
  makeEnv,
  makeScanEvent,
  makeScanner,
  makeScanStaff,
} from '../../../../test/helpers/index.ts';
import type { AppBindings } from '../../platform/context.ts';
import { run } from '../../platform/db.ts';
import { code, createGuardHarness, get, post } from './guard-test-fixtures.ts';

const harness = createGuardHarness();
let { f, clock, fake, orgId } = harness;
const build: typeof harness.build = async (...args) => {
  const result = await harness.build(...args);
  ({ f, clock, fake, orgId } = harness);
  return result;
};

describe('requireScanActor: guard order (SA 2.5)', () => {
  let app: Hono<AppBindings>;
  let env: Awaited<ReturnType<typeof makeEnv>>;
  beforeEach(async () => {
    ({ app, env } = await build());
  });

  it('nothing gives 401 SCANNER_UNAUTHENTICATED', async () => {
    const res = await get(app, env, '/ping', {});
    expect(res.status).toBe(401);
    expect(await code(res)).toBe('SCANNER_UNAUTHENTICATED');
  });

  it('an unknown token gives 401 SCANNER_UNAUTHENTICATED', async () => {
    const res = await get(app, env, '/ping', {
      authorization: `Bearer wls_abcdefgh_${'A'.repeat(43)}`,
    });
    expect(await code(res)).toBe('SCANNER_UNAUTHENTICATED');
  });

  it('a revoked scanner gives SCANNER_REVOKED', async () => {
    const s = await makeScanner(f, { orgId, revoked: true });
    const res = await get(app, env, '/ping', s.headers);
    expect(res.status).toBe(401);
    expect(await code(res)).toBe('SCANNER_REVOKED');
  });

  it('revoking the way the console does keeps the token matching, so the device hears why', async () => {
    const s = await makeScanner(f, { orgId });
    expect((await get(app, env, '/ping', s.headers)).status).toBe(200);
    await run(
      env.DB,
      `UPDATE scanners SET revoked_at = ?, staff_id = NULL, staff_since = NULL, staff_seen_at = NULL
       WHERE id = ?`,
      [clock.now(), s.id],
    );
    expect(await code(await get(app, env, '/ping', s.headers))).toBe('SCANNER_REVOKED');
  });

  it('a device the retention job expires hears SCANNER_EXPIRED, not the pairing card', async () => {
    const s = await makeScanner(f, { orgId });
    await run(env.DB, 'UPDATE scanners SET expires_at = ? WHERE id = ?', [clock.now() - 1, s.id]);
    expect(await code(await get(app, env, '/ping', s.headers))).toBe('SCANNER_EXPIRED');
  });

  it('an expired terminal and an idle device give SCANNER_EXPIRED', async () => {
    const t = await makeScanner(f, { orgId, kind: 'terminal', expiresAt: clock.now() - 1 });
    expect(await code(await get(app, env, '/ping', t.headers))).toBe('SCANNER_EXPIRED');
    const d = await makeScanner(f, { orgId, lastSeenAt: clock.now() - 31 * 86_400_000 });
    expect(await code(await get(app, env, '/ping', d.headers))).toBe('SCANNER_EXPIRED');
  });

  it('a suspended org gives 403 ORG_INACTIVE', async () => {
    const s = await makeScanner(f, { orgId });
    await run(env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [orgId]);
    const res = await get(app, env, '/ping', s.headers);
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('ORG_INACTIVE');
  });

  it('a user session without tenant membership gives 403 FORBIDDEN', async () => {
    const res = await post(app, env, fake.user(), { scope: { orgId, timeZone: 'UTC' } });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('FORBIDDEN');
  });

  it('admits a device, a terminal and an admin with a scope', async () => {
    const device = await makeScanner(f, { orgId });
    const terminal = await makeScanner(f, { orgId, kind: 'terminal' });
    const a = await get(app, env, '/ping', device.headers);
    expect(await a.json()).toMatchObject({
      principal: 'scanner',
      orgId,
      role: 'door',
      key: `s:${device.id}`,
    });
    const t = await get(app, env, '/ping', terminal.headers);
    expect(t.status).toBe(200);
    const admin = await post(app, env, fake.admin(), {
      scope: { orgId, timeZone: 'Europe/Bucharest' },
    });
    expect(admin.status).toBe(200);
    expect(await admin.json()).toMatchObject({ principal: 'admin', role: 'manager', orgId });
  });

  it('a scanner cookie and an admin session together: the scanner wins', async () => {
    const device = await makeScanner(f, { orgId });
    const admin = fake.admin();
    const res = await get(app, env, '/ping', {
      ...device.headers,
      cookie: `${device.headers.cookie}; ${admin.cookie}`,
    });
    expect(await res.json()).toMatchObject({ principal: 'scanner' });
  });

  it('the cookie transport needs the CSRF token on POST; the bearer does not', async () => {
    const device = await makeScanner(f, { orgId });
    const { 'x-csrf-token': _t, ...noToken } = device.headers;
    expect((await post(app, env, noToken)).status).toBe(403);
    expect((await post(app, env, device.headers)).status).toBe(200);
    const terminal = await makeScanner(f, { orgId, kind: 'terminal' });
    expect((await post(app, env, terminal.headers)).status).toBe(200);
  });

  it('a cookie token does not work as a bearer, nor a terminal token as a cookie', async () => {
    const device = await makeScanner(f, { orgId });
    const terminal = await makeScanner(f, { orgId, kind: 'terminal' });
    expect((await get(app, env, '/ping', { authorization: `Bearer ${device.token}` })).status).toBe(
      401,
    );
    expect(
      (await get(app, env, '/ping', { cookie: `__Host-wallet_scan=${terminal.token}` })).status,
    ).toBe(401);
  });

  it('a missing RL_SCAN binding gives 503', async () => {
    ({ app, env } = await build({ RL_SCAN: undefined }));
    const s = await makeScanner(f, { orgId });
    expect((await get(app, env, '/ping', s.headers)).status).toBe(503);
  });

  it('RL_SCAN_ORG is checked before RL_SCAN and can answer 429', async () => {
    ({ app, env } = await build({ RL_SCAN_ORG: fakeRateLimiter({ limit: 1 }) }));
    const s = await makeScanner(f, { orgId });
    expect((await get(app, env, '/ping', s.headers)).status).toBe(200);
    expect((await get(app, env, '/ping', s.headers)).status).toBe(429);
  });
});

describe('requireScanActor: with the faked principal', () => {
  it('fake.scanner reaches the guard when its scannerId names a makeScanner row', async () => {
    const { app, env } = await build({}, true);
    const row = await makeScanner(f, { orgId });
    const ok = await get(app, env, '/ping', fake.scanner({ scannerId: row.id, orgId }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ principal: 'scanner', key: `s:${row.id}` });
    const wrongMode = await get(
      app,
      env,
      '/ping',
      fake.scanner({ scannerId: row.id, orgId, mode: 'test' }),
    );
    expect(await code(wrongMode)).toBe('SCANNER_UNAUTHENTICATED');
    const screen = await get(
      app,
      env,
      '/scans',
      fake.scanner({ scannerId: row.id, orgId, deviceRole: 'customer' }),
    );
    expect(await code(screen)).toBe('SCREEN_ONLY');
    const lost = await get(app, env, '/ping', fake.scanner({ scannerId: 'no-such-row', orgId }));
    expect(await code(lost)).toBe('SCANNER_UNAUTHENTICATED');
  });
});

describe('requireScanActor: round trips (SA 13.1)', () => {
  it('a scan request costs at most 5 reads, with one scanner read and no write inside a minute', async () => {
    const counted = countD1((await makeEnv()).DB);
    const { app, env } = await build({ DB: counted.db });
    const staff = await makeScanStaff(f, { orgId, role: 'desk' });
    const ev = await makeScanEvent(f, { orgId });
    const s = await makeScanner(f, {
      orgId,
      eventId: ev.id,
      settings: { staffSignIn: true },
      staffId: staff.id,
    });
    counted.reset();
    const res = await get(app, env, '/ping', s.headers);
    expect(res.status).toBe(200);
    const sql = counted.sql();
    expect(counted.count(), sql.join('\n')).toBeLessThanOrEqual(5);
    expect(sql.filter((q) => /FROM scanners/.test(q))).toHaveLength(1);
    expect(sql.filter((q) => /^\s*UPDATE scanners/.test(q))).toHaveLength(0);
  });

  it('the touch writes once the row is a minute old', async () => {
    const counted = countD1((await makeEnv()).DB);
    const { app, env } = await build({ DB: counted.db });
    const s = await makeScanner(f, { orgId, lastSeenAt: clock.now() - 61_000 });
    counted.reset();
    await get(app, env, '/ping', s.headers);
    expect(counted.sql().filter((q) => /^\s*UPDATE scanners/.test(q))).toHaveLength(1);
  });
});
