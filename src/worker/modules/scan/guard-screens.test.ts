import type { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  fakeAuth,
  fakeRateLimiter,
  type makeEnv,
  makeScanEvent,
  makeScanner,
  makeTemplate,
} from '../../../../test/helpers/index.ts';
import type { AppBindings } from '../../platform/context.ts';
import { run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createScannerStore } from './auth-store.ts';
import { code, createGuardHarness, get, ORIGIN, post, scannerCsrf } from './guard-test-fixtures.ts';
import { pairedSession } from './pairing-session.ts';

const harness = createGuardHarness();
let { f, clock, fake, orgId } = harness;
const { persistApprovedTemplate } = harness;
const build: typeof harness.build = async (...args) => {
  const result = await harness.build(...args);
  ({ f, clock, fake, orgId } = harness);
  return result;
};

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

  it.each([
    { kind: 'display', deviceRole: 'monitor', allowed: true },
    { kind: 'display', deviceRole: 'customer', allowed: false },
    { kind: 'device', deviceRole: 'scan', allowed: false },
  ] as const)('only permits a staffless $deviceRole when explicitly allowed', async (shape) => {
    const { allowed, ...scannerShape } = shape;
    const screen = await makeScanner(f, {
      orgId,
      ...scannerShape,
      settings: { staffSignIn: true },
    });
    const response = await get(app, env, '/screen-authority', screen.headers);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ strict: false, monitor: allowed });
  });

  it('still fences a staffless monitor when credentials or scope are revoked', async () => {
    const revoked = await makeScanner(f, {
      orgId,
      kind: 'display',
      deviceRole: 'monitor',
      settings: { staffSignIn: true },
    });
    expect(
      await (await get(app, env, '/screen-authority?revoke=1', revoked.headers)).json(),
    ).toEqual({ strict: false, monitor: false });

    const template = makeTemplate({ id: f.ids.id(), orgId });
    await persistApprovedTemplate(template);
    const event = await makeScanEvent(f, { orgId, templateIds: [template.resolved.id] });
    const scoped = await makeScanner(f, {
      orgId,
      kind: 'display',
      deviceRole: 'monitor',
      eventId: event.id,
      settings: { staffSignIn: true },
    });
    await run(env.DB, 'UPDATE scan_events SET archived_at=1 WHERE id=?', [event.id]);
    expect(await (await get(app, env, '/screen-authority', scoped.headers)).json()).toEqual({
      strict: false,
      monitor: false,
    });
  });

  it('does not grant an unassigned session-backed monitor arbitrary templates', async () => {
    const template = makeTemplate({ id: f.ids.id(), orgId });
    await persistApprovedTemplate(template);
    const screen = await makeScanner(f, {
      orgId,
      kind: 'display',
      deviceRole: 'monitor',
      settings: { staffSignIn: true, acceptAllTemplates: false },
    });
    const path = `/screen-authority?templateId=${template.resolved.id}`;
    expect(await (await get(app, env, path, screen.headers)).json()).toEqual({
      strict: false,
      monitor: true,
    });

    const sessionId = f.ids.id();
    await run(
      env.DB,
      `INSERT INTO scanning_sessions
      (id,org_id,mode,name,status,accepts,settings,time_zone,created_at,updated_at)
      SELECT ?,org_id,mode,name,'active',NULL,settings,time_zone,created_at,updated_at
      FROM scanners WHERE id=?`,
      [sessionId, screen.id],
    );
    await run(
      env.DB,
      `INSERT INTO scanning_devices
      (scanner_id,session_id,org_id,mode,surface,effective_surface,overrides)
      SELECT id,?,org_id,mode,'desk','desk','{}' FROM scanners WHERE id=?`,
      [sessionId, screen.id],
    );
    expect(await (await get(app, env, path, screen.headers)).json()).toEqual({
      strict: false,
      monitor: false,
    });
  });

  it.each(screens)(
    'shows an invalid event as unassigned on a $deviceRole screen',
    async (shape) => {
      const template = makeTemplate({ id: f.ids.id(), orgId });
      await persistApprovedTemplate(template);
      const ev = await makeScanEvent(f, { orgId, templateIds: [template.resolved.id] });
      const screen = await makeScanner(f, {
        orgId,
        ...shape,
        eventId: ev.id,
        templateIds: [template.resolved.id],
        settings: { acceptAllTemplates: true },
      });
      await run(env.DB, 'UPDATE scan_events SET archived_at = 1 WHERE id = ?', [ev.id]);
      expect(await (await get(app, env, '/session', screen.headers)).json()).toMatchObject({
        event: null,
        templateIds: [],
        settings: { acceptAllTemplates: false },
        invalidScannerScope: true,
      });
      const unassigned = {
        state: 'unassigned',
        event: null,
        templates: [],
        formats: [],
        scanner: { settings: { acceptAllTemplates: false } },
      };
      expect(await (await get(app, env, '/dto', screen.headers)).json()).toMatchObject(unassigned);
      expect(
        await pairedSession(createServiceContext(env, { clock }), screen.id, scannerCsrf(screen)),
      ).toMatchObject(unassigned);
    },
  );

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
    const first = await get(app, env, '/scans', s.headers);
    expect(first.status).toBe(403);
    expect(await code(first)).toBe('SCREEN_ONLY');
    expect((await get(app, env, '/scans', s.headers)).status).toBe(429);
  });

  it('a screen on a scan route leaves an auth.denied event', async () => {
    const s = await makeScanner(f, { orgId, kind: 'display', deviceRole: 'monitor' });
    await get(app, env, '/scans', s.headers);
    expect(fake.denied).toMatchObject([{ code: 'FORBIDDEN', actorType: 'scanner', actorId: s.id }]);
  });

  it('resolves a display row with its kind and role, cookie only', async () => {
    const s = await makeScanner(f, { orgId, kind: 'display', deviceRole: 'monitor' });
    const store = createScannerStore(env, clock);
    expect(await store.resolve(s.token, 'cookie')).toMatchObject({
      scannerKind: 'display',
      deviceRole: 'monitor',
    });
    expect(await store.resolve(s.token, 'bearer')).toBeNull();
  });

  it('fake.scanner defaults to a device that scans, a terminal over bearer', async () => {
    const stores = fakeAuth(ORIGIN);
    const cookieHeaders = stores.scanner();
    const token = /=([^;]+)/.exec(cookieHeaders.cookie ?? '')?.[1] ?? '';
    expect(await stores.stores.scanners?.resolve(token, 'cookie')).toMatchObject({
      scannerKind: 'device',
      deviceRole: 'scan',
    });
    const bearer = stores.scanner({ transport: 'bearer' });
    const raw = bearer.authorization?.replace('Bearer ', '') ?? '';
    expect(await stores.stores.scanners?.resolve(raw, 'bearer')).toMatchObject({
      scannerKind: 'terminal',
      deviceRole: 'scan',
    });
  });

  it('a device scanner and an admin have no screen role to refuse', async () => {
    const s = await makeScanner(f, { orgId });
    expect((await get(app, env, '/scans', s.headers)).status).toBe(200);
    const admin = await post(app, env, fake.admin(), { scope: { orgId, timeZone: 'UTC' } });
    expect(admin.status).toBe(200);
  });
});
