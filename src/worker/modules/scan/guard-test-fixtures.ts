import { type Context, Hono } from 'hono';
import {
  type Fixtures,
  fakeAuth,
  fakeRateLimiter,
  fixtures,
  makeEnv,
  makeOrg,
  makeUser,
  persistTemplate,
  type TestTemplate,
} from '../../../../test/helpers/index.ts';
import { ManualClock } from '../../platform/clock.ts';
import { type AppBindings, requestContext } from '../../platform/context.ts';
import { handleError } from '../../platform/error-handler.ts';
import { createServiceContext, serviceContext } from '../../platform/service-context.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import type { ScanActor } from './actor.ts';
import { createScannerStore } from './auth-store.ts';
import { requireScanActor, scanActorOf } from './guard.ts';
import { actorAuthorityCurrent } from './repo-actor-authority.ts';
import { revokeScannerForGuard } from './repo-guard-test-fixtures.ts';
import { evaluate } from './resolve-evaluate.ts';
import { buildSession } from './session.ts';
import { grantScanMembership } from './test-kit.ts';

export const ORIGIN = 'https://wallet.test';

export function createGuardHarness() {
  let f: Fixtures;
  let clock: ManualClock;
  let fake: ReturnType<typeof fakeAuth>;
  let orgId: string;
  let capturedActor: ScanActor | undefined;

  async function persistApprovedTemplate(
    template: TestTemplate,
    modes: readonly ('live' | 'test')[] = ['live'],
  ) {
    await persistTemplate(f, template.resolved, { registry: template.registry });
    for (const mode of modes) {
      await approveAppleRelease(
        { ctx: createServiceContext(f.env, { clock }), fx: f, registry: template.registry },
        {
          templateId: template.resolved.id,
          orgId: template.resolved.orgId ?? orgId,
          version: template.resolved.version,
          mode,
        },
      );
    }
  }

  async function build(over: Record<string, unknown> = {}, fakeStore = false) {
    clock = new ManualClock(Date.UTC(2026, 5, 1, 12));
    const env = await makeEnv({
      RL_SCAN: fakeRateLimiter({ limit: 1000 }),
      RL_SCAN_ORG: fakeRateLimiter({ limit: 1000 }),
      ...over,
    } as never);
    f = fixtures(env, clock);
    fake = fakeAuth(ORIGIN);
    fake.bindSessions(env.DB, clock);
    capturedActor = undefined;
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
        adminEventTemplates: a.adminEventTemplates ?? false,
        event: a.event ? { id: a.event.id } : null,
        settings: a.settings,
        invalidScannerScope: a.invalidScannerScope ?? false,
        key: a.actorKey,
        staff: a.staff?.name ?? null,
      });
    };
    app.get('/ping', requireScanActor(), summary as never);
    app.post('/ping', requireScanActor(), summary as never);
    app.get('/session', requireScanActor({ staffOptional: true, screens: true }), summary as never);
    app.get('/dto', requireScanActor({ staffOptional: true, screens: true }), async (c) =>
      c.json(await buildSession(serviceContext(c), scanActorOf(c))),
    );
    app.get('/evaluate', requireScanActor(), async (c) =>
      c.json(
        await evaluate(serviceContext(c), scanActorOf(c), {
          code: 'no-such-code',
          method: 'camera',
        }),
      ),
    );
    app.get('/authority', requireScanActor(), async (c) => {
      const actor = scanActorOf(c);
      const templateId = c.req.query('templateId');
      return c.json({
        current: await actorAuthorityCurrent(c.env.DB, {
          actor,
          now: clock.now(),
          event: actor.event,
          adminEventTemplates: false,
          ...(templateId ? { templateId } : {}),
        }),
      });
    });
    const capture = (c: Context<AppBindings>) => {
      capturedActor = scanActorOf(c);
      return c.json({ ok: true });
    };
    app.get('/capture-read', requireScanActor({ capability: 'scanning:read' }), capture);
    app.post('/capture-read', requireScanActor({ capability: 'scanning:read' }), capture);
    app.get('/capture-operate', requireScanActor({ capability: 'passes:operate' }), capture);
    app.get('/capture-manage', requireScanActor(), capture);
    app.get(
      '/screen-authority',
      requireScanActor({ staffOptional: true, screens: true }),
      async (c) => {
        const actor = scanActorOf(c);
        if (c.req.query('revoke') && actor.scanner)
          await revokeScannerForGuard(c.env.DB, actor.scanner.id, clock.now());
        const templateId = c.req.query('templateId');
        const input = {
          actor,
          now: clock.now(),
          event: actor.event,
          adminEventTemplates: false,
          ...(templateId ? { templateId } : {}),
        };
        return c.json({
          strict: await actorAuthorityCurrent(c.env.DB, input),
          monitor: await actorAuthorityCurrent(c.env.DB, { ...input, allowStafflessScreen: true }),
        });
      },
    );
    app.post('/unpair', requireScanActor({ staffOptional: true, screens: true }), summary as never);
    for (const path of ['/resolve', '/actions', '/lookup', '/scans/x/undo'])
      app.post(path, requireScanActor(), summary as never);
    for (const path of ['/scans', '/stats', '/summary', '/passes/x/assets/y'])
      app.get(path, requireScanActor(), summary as never);
    orgId = (await makeOrg(f)).id;
    await makeUser(f, { id: 'admin-1' });
    await grantScanMembership(f, orgId, 'admin-1');
    return { app, env };
  }

  return {
    get f() {
      return f;
    },
    get clock() {
      return clock;
    },
    get fake() {
      return fake;
    },
    get orgId() {
      return orgId;
    },
    get capturedActor() {
      return capturedActor;
    },
    build,
    persistApprovedTemplate,
  };
}

export function scannerCsrf(scanner: { headers: Record<string, string> }): string {
  const token = scanner.headers['x-csrf-token'];
  if (!token) throw new Error('Scanner fixture has no CSRF token.');
  return token;
}

export const get = (
  app: Hono<AppBindings>,
  env: object,
  path: string,
  headers: Record<string, string>,
) => app.request(`${ORIGIN}${path}`, { headers }, env);
export const post = (
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
export const code = async (res: Response) => ((await res.json()) as { code: string }).code;
