import type { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type makeEnv,
  makeOrg,
  makeScanEvent,
  makeScanner,
  makeTemplate,
  persistTemplate,
} from '../../../../test/helpers/index.ts';
import type { AppBindings } from '../../platform/context.ts';
import { run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { code, createGuardHarness, get, ORIGIN, post, scannerCsrf } from './guard-test-fixtures.ts';
import { pairedSession } from './pairing-session.ts';
import { countOrgTemplates, readValidEventScope } from './repo-scope.ts';

const harness = createGuardHarness();
let { f, clock, fake, orgId } = harness;
const { persistApprovedTemplate } = harness;
const build: typeof harness.build = async (...args) => {
  const result = await harness.build(...args);
  ({ f, clock, fake, orgId } = harness);
  return result;
};

describe('requireScanActor: scope: requests and admin', () => {
  let app: Hono<AppBindings>;
  let env: Awaited<ReturnType<typeof makeEnv>>;
  beforeEach(async () => {
    ({ app, env } = await build());
  });

  it('requires the original scanner CSRF token when building a pairing session', async () => {
    const scanner = await makeScanner(f, { orgId, settings: { acceptAllTemplates: true } });
    const ctx = createServiceContext(env, { clock });
    await expect(pairedSession(ctx, scanner.id, null)).rejects.toMatchObject({
      code: 'PAIRING_INVALID',
    });
    await expect(pairedSession(ctx, scanner.id, 'wrong-token')).rejects.toMatchObject({
      code: 'SCANNER_UNAUTHENTICATED',
    });
    expect(await pairedSession(ctx, scanner.id, scannerCsrf(scanner))).toMatchObject({
      state: 'ready',
      csrfToken: scannerCsrf(scanner),
    });
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

  it('distinguishes an admin event-wide scope from an explicit template subset', async () => {
    const a = makeTemplate({ id: f.ids.id(), orgId });
    const b = makeTemplate({ id: f.ids.id(), orgId });
    await persistApprovedTemplate(a);
    await persistApprovedTemplate(b);
    const event = await makeScanEvent(f, {
      orgId,
      templateIds: [a.resolved.id, b.resolved.id],
    });
    const whole = await post(app, env, fake.admin(), {
      scope: { orgId, eventId: event.id, timeZone: 'UTC' },
    });
    expect(await whole.json()).toMatchObject({
      adminEventTemplates: true,
      templateIds: [a.resolved.id, b.resolved.id].sort(),
    });
    const subset = await post(app, env, fake.admin(), {
      scope: { orgId, eventId: event.id, templateIds: [a.resolved.id], timeZone: 'UTC' },
    });
    expect(await subset.json()).toMatchObject({
      adminEventTemplates: false,
      templateIds: [a.resolved.id],
    });
  });

  it.each(['draft', null] as const)(
    'uses the approved release for admin, event and scanner scopes when the legacy version is %s',
    async (legacyVersion) => {
      const template = makeTemplate({ id: f.ids.id(), orgId });
      await persistApprovedTemplate(template);
      if (legacyVersion !== null) {
        const draft = makeTemplate({ id: template.resolved.id, orgId, version: legacyVersion });
        await persistTemplate(f, draft.resolved, { registry: draft.registry });
      }
      await run(env.DB, 'UPDATE templates SET active_version = ? WHERE id = ?', [
        legacyVersion,
        template.resolved.id,
      ]);
      const event = await makeScanEvent(f, { orgId, templateIds: [template.resolved.id] });
      const scanner = await makeScanner(f, {
        orgId,
        eventId: event.id,
        settings: { acceptAllTemplates: true },
      });
      expect(await countOrgTemplates(env.DB, orgId, 'live', [template.resolved.id])).toBe(1);
      expect(await readValidEventScope(env.DB, orgId, 'live', event.id)).toMatchObject({
        templateIds: [template.resolved.id],
      });
      expect(await (await get(app, env, '/ping', scanner.headers)).json()).toMatchObject({
        event: { id: event.id },
        templateIds: [template.resolved.id],
        settings: { acceptAllTemplates: false },
        invalidScannerScope: false,
      });
      const explicit = await makeScanner(f, {
        orgId,
        templateIds: [template.resolved.id],
        settings: { acceptAllTemplates: true },
      });
      expect(await (await get(app, env, '/ping', explicit.headers)).json()).toMatchObject({
        event: null,
        templateIds: [template.resolved.id],
        settings: { acceptAllTemplates: false },
        invalidScannerScope: false,
      });
      const whole = await post(app, env, fake.admin(), {
        scope: { orgId, eventId: event.id, timeZone: 'UTC' },
      });
      expect(whole.status).toBe(200);
      expect(await whole.json()).toMatchObject({ templateIds: [template.resolved.id] });
      const subset = await post(app, env, fake.admin(), {
        scope: {
          orgId,
          eventId: event.id,
          templateIds: [template.resolved.id],
          timeZone: 'UTC',
        },
      });
      expect(subset.status).toBe(200);
      expect(await subset.json()).toMatchObject({ templateIds: [template.resolved.id] });
    },
  );

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
    const template = makeTemplate({ id: f.ids.id(), orgId });
    await persistApprovedTemplate(template);
    const live = await makeScanEvent(f, { orgId, templateIds: [template.resolved.id] });
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
