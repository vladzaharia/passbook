import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  countD1,
  type Fixtures,
  fakeAuth,
  fakeRateLimiter,
  fixtures,
  makeEnv,
  makeOrg,
  makeScanEvent,
  makeScanner,
  makeScanStaff,
  makeTemplate,
  persistTemplate,
} from '../../../../test/helpers/index.ts';
import { ManualClock } from '../../platform/clock.ts';
import { type AppBindings, requestContext } from '../../platform/context.ts';
import { all, run } from '../../platform/db.ts';
import { handleError } from '../../platform/error-handler.ts';
import { createScannerStore } from './auth-store.ts';
import { requireScanActor, scanActorOf } from './guard.ts';

const ORIGIN = 'https://wallet.test';
let f: Fixtures;
let clock: ManualClock;
let fake: ReturnType<typeof fakeAuth>;
let orgId: string;

async function build(over: Record<string, unknown> = {}, fakeStore = false) {
  clock = new ManualClock(Date.UTC(2026, 5, 1, 12));
  const env = await makeEnv({
    RL_SCAN: fakeRateLimiter({ limit: 1000 }),
    RL_SCAN_ORG: fakeRateLimiter({ limit: 1000 }),
    ...over,
  } as never);
  f = fixtures(env, clock);
  fake = fakeAuth(ORIGIN);
  const stores = fakeStore
    ? fake.stores
    : { ...fake.stores, scanners: createScannerStore(env, clock) };
  const app = new Hono<AppBindings>();
  app.use('*', requestContext({ stores, clock }));
  app.onError(handleError);
  const summary = (c: never) => {
    const a = scanActorOf(c);
    return (c as { json(v: unknown): Response }).json({
      principal: a.principal,
      role: a.role,
      orgId: a.orgId,
      mode: a.mode,
      templateIds: a.templateIds,
      key: a.actorKey,
      staff: a.staff?.name ?? null,
    });
  };
  app.get('/ping', requireScanActor(), summary as never);
  app.post('/ping', requireScanActor(), summary as never);
  app.get('/session', requireScanActor({ staffOptional: true, screens: true }), summary as never);
  app.post('/unpair', requireScanActor({ staffOptional: true, screens: true }), summary as never);
  for (const path of ['/resolve', '/actions', '/lookup', '/scans/x/undo'])
    app.post(path, requireScanActor(), summary as never);
  for (const path of ['/scans', '/stats', '/summary', '/passes/x/assets/y'])
    app.get(path, requireScanActor(), summary as never);
  orgId = (await makeOrg(f)).id;
  return { app, env };
}

const get = (app: Hono<AppBindings>, env: object, path: string, headers: Record<string, string>) =>
  app.request(`${ORIGIN}${path}`, { headers }, env);
const post = (
  app: Hono<AppBindings>,
  env: object,
  headers: Record<string, string>,
  body: unknown = {},
) =>
  app.request(
    `${ORIGIN}/ping`,
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );
const code = async (res: Response) => ((await res.json()) as { code: string }).code;

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

  it('a user session gives 403 FORBIDDEN', async () => {
    const res = await get(app, env, '/ping', fake.user());
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

describe('requireScanActor: staff binding', () => {
  let app: Hono<AppBindings>;
  let env: Awaited<ReturnType<typeof makeEnv>>;
  beforeEach(async () => {
    ({ app, env } = await build());
  });

  it('sign-in on and nobody bound gives 403 STAFF_REQUIRED, except on the exempt routes', async () => {
    const s = await makeScanner(f, { orgId, settings: { staffSignIn: true } });
    const res = await get(app, env, '/ping', s.headers);
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('STAFF_REQUIRED');
    const exempt = await get(app, env, '/session', s.headers);
    expect(exempt.status).toBe(200);
    expect(await exempt.json()).toMatchObject({ role: null });
  });

  it('a bound staff member sets the role', async () => {
    const staff = await makeScanStaff(f, { orgId, role: 'desk' });
    const s = await makeScanner(f, { orgId, settings: { staffSignIn: true }, staffId: staff.id });
    expect(await (await get(app, env, '/ping', s.headers)).json()).toMatchObject({
      role: 'desk',
      staff: staff.name,
    });
  });

  it('the binding ends at 15 minutes idle', async () => {
    const staff = await makeScanStaff(f, { orgId, role: 'desk' });
    const s = await makeScanner(f, {
      orgId,
      settings: { staffSignIn: true },
      staffId: staff.id,
      staffSeenAt: clock.now() - 16 * 60_000,
    });
    expect(await code(await get(app, env, '/ping', s.headers))).toBe('STAFF_REQUIRED');
    const rows = await all<{ staff_id: string | null }>(
      env.DB,
      'SELECT staff_id FROM scanners WHERE id = ?',
      [s.id],
    );
    expect(rows[0]?.staff_id).toBeNull();
  });

  it('the binding ends at 12 hours, and when the person is disabled', async () => {
    const staff = await makeScanStaff(f, { orgId, role: 'desk' });
    const old = await makeScanner(f, {
      orgId,
      settings: { staffSignIn: true },
      staffId: staff.id,
      staffSince: clock.now() - 13 * 3_600_000,
    });
    expect(await code(await get(app, env, '/ping', old.headers))).toBe('STAFF_REQUIRED');
    const gone = await makeScanStaff(f, { orgId, role: 'desk', disabled: true });
    const s = await makeScanner(f, { orgId, settings: { staffSignIn: true }, staffId: gone.id });
    expect(await code(await get(app, env, '/ping', s.headers))).toBe('STAFF_REQUIRED');
  });

  it('without sign-in the role is roleWithoutSignIn; a terminal never needs staff', async () => {
    const desk = await makeScanner(f, { orgId, settings: { roleWithoutSignIn: 'desk' } });
    expect(await (await get(app, env, '/ping', desk.headers)).json()).toMatchObject({
      role: 'desk',
    });
    const t = await makeScanner(f, { orgId, kind: 'terminal', settings: { staffSignIn: true } });
    expect(await (await get(app, env, '/ping', t.headers)).json()).toMatchObject({ role: 'door' });
  });
});

describe('requireScanActor: scope', () => {
  let app: Hono<AppBindings>;
  let env: Awaited<ReturnType<typeof makeEnv>>;
  beforeEach(async () => {
    ({ app, env } = await build());
  });

  it('a scanner request with scope gives 422 SCAN_SCOPE_NOT_ALLOWED', async () => {
    const s = await makeScanner(f, { orgId });
    const res = await post(app, env, s.headers, { scope: { orgId, timeZone: 'UTC' } });
    expect(res.status).toBe(422);
    expect(await code(res)).toBe('SCAN_SCOPE_NOT_ALLOWED');
    const q = await get(app, env, `/ping?orgId=${orgId}`, s.headers);
    expect(await code(q)).toBe('SCAN_SCOPE_NOT_ALLOWED');
  });

  it('a body that is not JSON gets 422 SCAN_BODY_INVALID', async () => {
    const s = await makeScanner(f, { orgId });
    const res = await app.request(
      `${ORIGIN}/ping`,
      {
        method: 'POST',
        headers: { ...s.headers, 'content-type': 'application/json' },
        body: '{nope',
      },
      env,
    );
    expect(res.status).toBe(422);
    expect(await code(res)).toBe('SCAN_BODY_INVALID');
  });

  it('an admin without a scope gets 422 SCAN_SCOPE_REQUIRED', async () => {
    const res = await post(app, env, fake.admin());
    expect(res.status).toBe(422);
    expect(await code(res)).toBe('SCAN_SCOPE_REQUIRED');
  });

  it('an admin scope naming another org or an unknown id gets the same 404', async () => {
    const other = await makeOrg(f);
    const otherEvent = await makeScanEvent(f, { orgId: other.id });
    const unknown = await post(app, env, fake.admin(), {
      scope: { orgId, eventId: 'nope', timeZone: 'UTC' },
    });
    const foreign = await post(app, env, fake.admin(), {
      scope: { orgId, eventId: otherEvent.id, timeZone: 'UTC' },
    });
    expect(unknown.status).toBe(404);
    expect(foreign.status).toBe(404);
    const strip = (b: Record<string, unknown>) => ({ ...b, requestId: undefined });
    expect(strip((await unknown.json()) as never)).toEqual(strip((await foreign.json()) as never));
    expect(
      (await post(app, env, fake.admin(), { scope: { orgId: 'nope', timeZone: 'UTC' } })).status,
    ).toBe(404);
  });

  it('an admin event of the other mode is a 404; templates must belong to the org', async () => {
    const testEvent = await makeScanEvent(f, { orgId, mode: 'test' });
    const res = await post(app, env, fake.admin(), {
      scope: { orgId, eventId: testEvent.id, timeZone: 'UTC' },
    });
    expect(res.status).toBe(404);
    const live = await makeScanEvent(f, { orgId });
    expect(
      (await post(app, env, fake.admin(), { scope: { orgId, eventId: live.id, timeZone: 'UTC' } }))
        .status,
    ).toBe(200);
    const bad = await post(app, env, fake.admin(), {
      scope: { orgId, templateIds: ['nope'], timeZone: 'UTC' },
    });
    expect(bad.status).toBe(404);
  });

  it('an admin undoes with a scope in the body and reads an asset with it in the query', async () => {
    const scope = { orgId, timeZone: 'UTC' };
    const undo = await app.request(
      `${ORIGIN}/scans/x/undo`,
      {
        method: 'POST',
        headers: { ...fake.admin(), 'content-type': 'application/json' },
        body: JSON.stringify({ idempotencyKey: 'k', scope }),
      },
      env,
    );
    expect(undo.status).toBe(200);
    const asset = await get(
      app,
      env,
      `/passes/x/assets/y?g=grant&orgId=${orgId}&timeZone=UTC`,
      fake.admin(),
    );
    expect(asset.status).toBe(200);
    const bare = await get(app, env, '/passes/x/assets/y?g=grant', fake.admin());
    expect(await code(bare)).toBe('SCAN_SCOPE_REQUIRED');
  });

  it('a scanner reaches the live templates of its event, and not a deleted or foreign one', async () => {
    const a = makeTemplate({ id: 'tpl-a', orgId });
    const b = makeTemplate({ id: 'tpl-b', orgId });
    const gone = makeTemplate({ id: 'tpl-gone', orgId });
    const other = await makeOrg(f);
    const foreign = makeTemplate({ id: 'tpl-foreign', orgId: other.id });
    for (const t of [a, b, gone, foreign]) await persistTemplate(f, t.resolved);
    await run(env.DB, "UPDATE templates SET status = 'deleted' WHERE id = 'tpl-gone'");
    const ev = await makeScanEvent(f, {
      orgId,
      templateIds: ['tpl-a', 'tpl-b', 'tpl-gone', 'tpl-foreign'],
    });
    const s = await makeScanner(f, { orgId, eventId: ev.id });
    expect(await (await get(app, env, '/ping', s.headers)).json()).toMatchObject({
      templateIds: ['tpl-a', 'tpl-b'],
    });
    const own = await makeScanner(f, { orgId, templateIds: ['tpl-b', 'tpl-gone'] });
    expect(await (await get(app, env, '/ping', own.headers)).json()).toMatchObject({
      templateIds: ['tpl-b'],
    });
  });

  it('an archived event, or one of the other mode, counts as no event', async () => {
    const a = makeTemplate({ id: 'tpl-own', orgId });
    await persistTemplate(f, a.resolved);
    const archived = await makeScanEvent(f, { orgId, templateIds: [] });
    await run(env.DB, 'UPDATE scan_events SET archived_at = 1 WHERE id = ?', [archived.id]);
    const wrongMode = await makeScanEvent(f, { orgId, mode: 'test' });
    for (const eventId of [archived.id, wrongMode.id]) {
      const s = await makeScanner(f, { orgId, eventId, templateIds: ['tpl-own'] });
      const res = await (await get(app, env, '/ping', s.headers)).json();
      expect(res).toMatchObject({ templateIds: ['tpl-own'] });
    }
  });

  it('logs nothing that contains a token', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    const s = await makeScanner(f, { orgId });
    await get(app, env, '/ping', s.headers);
    await get(app, env, '/ping', { authorization: `Bearer wls_abcdefgh_${'A'.repeat(43)}` });
    await get(app, env, '/ping', { ...s.headers, 'x-csrf-token': 'wrong' });
    const text = spies
      .flatMap((spy) => spy.mock.calls)
      .map((call) =>
        call.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '),
      )
      .join('\n');
    expect(text).not.toContain(s.token);
    expect(text).not.toContain('wls_abcdefgh');
    vi.restoreAllMocks();
  });
});

describe('requireScanActor: screens (SA 2.5 step 4)', () => {
  let app: Hono<AppBindings>;
  let env: Awaited<ReturnType<typeof makeEnv>>;
  beforeEach(async () => {
    ({ app, env } = await build());
  });

  const screens = [
    { kind: 'display', deviceRole: 'customer' },
    { kind: 'display', deviceRole: 'monitor' },
    { kind: 'device', deviceRole: 'customer' },
  ] as const;

  it.each(screens)(
    'a $kind with role $deviceRole is refused on every scan route',
    async (shape) => {
      const s = await makeScanner(f, { orgId, ...shape });
      for (const path of ['/resolve', '/actions', '/lookup', '/scans/x/undo']) {
        const res = await app.request(
          `${ORIGIN}${path}`,
          {
            method: 'POST',
            headers: { ...s.headers, 'content-type': 'application/json' },
            body: '{}',
          },
          env,
        );
        expect(res.status, path).toBe(403);
        expect(await code(res), path).toBe('SCREEN_ONLY');
      }
      for (const path of ['/scans', '/stats', '/summary', '/passes/x/assets/y?g=1']) {
        const res = await get(app, env, path, s.headers);
        expect(res.status, path).toBe(403);
        expect(await code(res), path).toBe('SCREEN_ONLY');
      }
    },
  );

  it('a screen reaches the session and may unpair', async () => {
    const s = await makeScanner(f, { orgId, kind: 'display', deviceRole: 'customer' });
    expect((await get(app, env, '/session', s.headers)).status).toBe(200);
    const unpair = await app.request(
      `${ORIGIN}/unpair`,
      { method: 'POST', headers: { ...s.headers, 'content-type': 'application/json' }, body: '{}' },
      env,
    );
    expect(unpair.status).toBe(200);
  });

  it('a suspended org answers ORG_INACTIVE for a screen, before SCREEN_ONLY', async () => {
    const s = await makeScanner(f, { orgId, kind: 'display', deviceRole: 'monitor' });
    await run(env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [orgId]);
    expect(await code(await get(app, env, '/scans', s.headers))).toBe('ORG_INACTIVE');
  });

  it('a rate limited screen answers 429 before SCREEN_ONLY', async () => {
    ({ app, env } = await build({ RL_SCAN: fakeRateLimiter({ limit: 1 }) }));
    const s = await makeScanner(f, { orgId, kind: 'display', deviceRole: 'monitor' });
    expect((await get(app, env, '/scans', s.headers)).status).toBe(403);
    expect((await get(app, env, '/scans', s.headers)).status).toBe(429);
  });

  it('a device scanner and an admin have no screen role to refuse', async () => {
    const s = await makeScanner(f, { orgId });
    expect((await get(app, env, '/scans', s.headers)).status).toBe(200);
    const admin = await post(app, env, fake.admin(), { scope: { orgId, timeZone: 'UTC' } });
    expect(admin.status).toBe(200);
  });
});

describe('requireScanActor: with the faked principal', () => {
  it('fake.scanner reaches the guard when its scannerId names a makeScanner row', async () => {
    const { app, env } = await build({}, true);
    const row = await makeScanner(f, { orgId });
    const ok = await get(app, env, '/ping', fake.scanner({ scannerId: row.id, orgId }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ principal: 'scanner', key: `s:${row.id}` });
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
