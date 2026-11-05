import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Fixtures,
  fakeAuth,
  fakeRateLimiter,
  fixtures,
  makeEnv,
  makeOrg,
  makeScanEvent,
  makeScanner,
  makeScanStaff,
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

async function build(over: Record<string, unknown> = {}) {
  clock = new ManualClock(Date.UTC(2026, 5, 1, 12));
  const env = await makeEnv({
    RL_SCAN: fakeRateLimiter({ limit: 1000 }),
    RL_SCAN_ORG: fakeRateLimiter({ limit: 1000 }),
    ...over,
  } as never);
  f = fixtures(env, clock);
  fake = fakeAuth(ORIGIN);
  const stores = { ...fake.stores, scanners: createScannerStore(env, clock) };
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
  app.get('/session', requireScanActor({ staffOptional: true }), summary as never);
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

  it('a scanner reaches its event templates', async () => {
    const ev = await makeScanEvent(f, { orgId });
    const s = await makeScanner(f, { orgId, eventId: ev.id });
    expect(await (await get(app, env, '/ping', s.headers)).json()).toMatchObject({
      templateIds: [],
    });
  });

  it('logs nothing that contains a token', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = await makeScanner(f, { orgId });
    await get(app, env, '/ping', s.headers);
    await get(app, env, '/ping', { authorization: `Bearer wls_abcdefgh_${'A'.repeat(43)}` });
    const text = [...spy.mock.calls, ...err.mock.calls].map((c) => String(c[0])).join('\n');
    expect(text).not.toContain(s.token);
    expect(text).not.toContain('wls_abcdefgh');
    vi.restoreAllMocks();
  });
});
