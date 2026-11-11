import type { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type makeEnv,
  makeScanEvent,
  makeScanner,
  makeTemplate,
  persistTemplate,
} from '../../../../test/helpers/index.ts';
import type { AppBindings } from '../../platform/context.ts';
import { run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createGuardHarness, get, scannerCsrf } from './guard-test-fixtures.ts';
import { pairedSession } from './pairing-session.ts';

const harness = createGuardHarness();
let { f, clock, orgId } = harness;
const { persistApprovedTemplate } = harness;
const build: typeof harness.build = async (...args) => {
  const result = await harness.build(...args);
  ({ f, clock, orgId } = harness);
  return result;
};

describe('requireScanActor: scope: workspace assignments', () => {
  let app: Hono<AppBindings>;
  let env: Awaited<ReturnType<typeof makeEnv>>;
  beforeEach(async () => {
    ({ app, env } = await build());
  });

  it.each(['empty', 'overlong', 'over-limit'] as const)(
    'denies an %s own-template scope even when its workspace is valid',
    async (kind) => {
      const own = makeTemplate({ id: f.ids.id(), orgId });
      await persistApprovedTemplate(own);
      const templateIds = [own.resolved.id];
      const extraCount = kind === 'over-limit' ? 20 : 1;
      for (let i = 0; i < extraCount; i++) {
        const id =
          kind === 'empty' ? '' : kind === 'overlong' ? f.ids.id().padEnd(65, 'x') : f.ids.id();
        const extra = makeTemplate({ id, orgId });
        await persistTemplate(f, extra.resolved, { registry: extra.registry });
        templateIds.push(extra.resolved.id);
      }
      const scanner = await makeScanner(f, {
        orgId,
        templateIds,
        settings: { acceptAllTemplates: true },
      });
      const sessionId = f.ids.id();
      await run(
        env.DB,
        `INSERT INTO scanning_sessions
          (id,org_id,mode,name,status,accepts,settings,time_zone,created_at,updated_at)
         SELECT ?,org_id,mode,name,'active',?,settings,time_zone,created_at,updated_at
         FROM scanners WHERE id = ?`,
        [sessionId, JSON.stringify({ templateIds: [own.resolved.id] }), scanner.id],
      );
      await run(
        env.DB,
        `INSERT INTO scanning_devices
          (scanner_id,session_id,org_id,mode,surface,effective_surface,overrides)
         SELECT id,?,org_id,mode,'phone','phone','{}' FROM scanners WHERE id = ?`,
        [sessionId, scanner.id],
      );
      expect(await (await get(app, env, '/ping', scanner.headers)).json()).toMatchObject({
        event: null,
        templateIds: [],
        settings: { acceptAllTemplates: false },
        invalidScannerScope: true,
      });
      expect(await (await get(app, env, '/evaluate', scanner.headers)).json()).toMatchObject({
        stop: true,
        kind: 'refused',
        reason: 'not_accepted',
      });
      const unassigned = {
        state: 'unassigned',
        event: null,
        templates: [],
        scanner: { settings: { acceptAllTemplates: false } },
        workspace: {
          session: { accepts: null, settings: { acceptAllTemplates: false } },
          device: { settings: { acceptAllTemplates: false } },
        },
      };
      expect(await (await get(app, env, '/dto', scanner.headers)).json()).toMatchObject(unassigned);
      expect(
        await pairedSession(createServiceContext(env, { clock }), scanner.id, scannerCsrf(scanner)),
      ).toMatchObject(unassigned);
    },
  );

  it('does not let an accept-all workspace override an invalid pinned event', async () => {
    const template = makeTemplate({ id: f.ids.id(), orgId });
    await persistApprovedTemplate(template);
    const ev = await makeScanEvent(f, { orgId, templateIds: [template.resolved.id] });
    const scanner = await makeScanner(f, {
      orgId,
      eventId: ev.id,
      templateIds: [template.resolved.id],
      settings: { acceptAllTemplates: true },
    });
    await run(env.DB, 'UPDATE scan_events SET archived_at = 1 WHERE id = ?', [ev.id]);
    const sessionId = f.ids.id();
    await run(
      env.DB,
      `INSERT INTO scanning_sessions
        (id,org_id,mode,name,status,accepts,settings,time_zone,created_at,updated_at)
       SELECT ?,org_id,mode,name,'active',NULL,settings,time_zone,created_at,updated_at
       FROM scanners WHERE id = ?`,
      [sessionId, scanner.id],
    );
    await run(
      env.DB,
      `INSERT INTO scanning_devices
        (scanner_id,session_id,org_id,mode,surface,effective_surface,overrides)
       SELECT id,?,org_id,mode,'phone','phone','{}' FROM scanners WHERE id = ?`,
      [sessionId, scanner.id],
    );
    expect(await (await get(app, env, '/ping', scanner.headers)).json()).toMatchObject({
      event: null,
      templateIds: [],
      settings: { acceptAllTemplates: false },
      invalidScannerScope: true,
    });
    expect(await (await get(app, env, '/evaluate', scanner.headers)).json()).toMatchObject({
      stop: true,
      kind: 'refused',
      reason: 'not_accepted',
    });
    const unassigned = {
      state: 'unassigned',
      event: null,
      templates: [],
      scanner: { settings: { acceptAllTemplates: false } },
      workspace: {
        session: { accepts: null, settings: { acceptAllTemplates: false } },
        device: { settings: { acceptAllTemplates: false } },
      },
    };
    expect(await (await get(app, env, '/dto', scanner.headers)).json()).toMatchObject(unassigned);
    expect(
      await pairedSession(createServiceContext(env, { clock }), scanner.id, scannerCsrf(scanner)),
    ).toMatchObject(unassigned);
  });

  it('binds the current workspace scope before building the pairing session', async () => {
    const template = makeTemplate({ id: f.ids.id(), orgId });
    await persistApprovedTemplate(template);
    const ev = await makeScanEvent(f, { orgId, templateIds: [template.resolved.id] });
    const scanner = await makeScanner(f, { orgId, settings: { acceptAllTemplates: true } });
    const sessionId = f.ids.id();
    await run(
      env.DB,
      `INSERT INTO scanning_sessions
        (id,org_id,mode,name,status,accepts,settings,time_zone,created_at,updated_at)
       SELECT ?,org_id,mode,name,'active',?,settings,time_zone,created_at,updated_at
       FROM scanners WHERE id = ?`,
      [sessionId, JSON.stringify({ eventId: ev.id }), scanner.id],
    );
    await run(
      env.DB,
      `INSERT INTO scanning_devices
        (scanner_id,session_id,org_id,mode,surface,effective_surface,overrides)
       SELECT id,?,org_id,mode,'phone','phone','{}' FROM scanners WHERE id = ?`,
      [sessionId, scanner.id],
    );
    const assigned = {
      state: 'ready',
      event: { id: ev.id },
      scanner: { settings: { acceptAllTemplates: false } },
      workspace: {
        session: {
          id: sessionId,
          accepts: { eventId: ev.id },
          settings: { acceptAllTemplates: false },
        },
        device: { settings: { acceptAllTemplates: false } },
      },
    };
    expect(await (await get(app, env, '/dto', scanner.headers)).json()).toMatchObject(assigned);
    expect(
      await pairedSession(createServiceContext(env, { clock }), scanner.id, scannerCsrf(scanner)),
    ).toMatchObject(assigned);
  });

  it.each(['event', 'templates'] as const)(
    'marks a workspace with an unapproved %s scope invalid and unassigned',
    async (kind) => {
      const approved = makeTemplate({ id: f.ids.id(), orgId });
      const wrongMode = makeTemplate({ id: f.ids.id(), orgId });
      await persistApprovedTemplate(approved);
      await persistApprovedTemplate(wrongMode, ['test']);
      const event = await makeScanEvent(f, {
        orgId,
        templateIds: [approved.resolved.id, wrongMode.resolved.id],
      });
      const scanner = await makeScanner(f, { orgId, settings: { acceptAllTemplates: true } });
      const sessionId = f.ids.id();
      const accepts =
        kind === 'event'
          ? { eventId: event.id }
          : { templateIds: [approved.resolved.id, wrongMode.resolved.id] };
      await run(
        env.DB,
        `INSERT INTO scanning_sessions
          (id,org_id,mode,name,status,accepts,settings,time_zone,created_at,updated_at)
         SELECT ?,org_id,mode,name,'active',?,settings,time_zone,created_at,updated_at
         FROM scanners WHERE id = ?`,
        [sessionId, JSON.stringify(accepts), scanner.id],
      );
      await run(
        env.DB,
        `INSERT INTO scanning_devices
          (scanner_id,session_id,org_id,mode,surface,effective_surface,overrides)
         SELECT id,?,org_id,mode,'phone','phone','{}' FROM scanners WHERE id = ?`,
        [sessionId, scanner.id],
      );
      expect(await (await get(app, env, '/ping', scanner.headers)).json()).toMatchObject({
        event: null,
        templateIds: [],
        invalidScannerScope: true,
        settings: { acceptAllTemplates: false },
      });
      expect(
        await (
          await get(app, env, `/authority?templateId=${approved.resolved.id}`, scanner.headers)
        ).json(),
      ).toEqual({ current: false });
      const unassigned = {
        state: 'unassigned',
        event: null,
        templates: [],
        scanner: { settings: { acceptAllTemplates: false } },
        workspace: {
          session: { accepts: null, settings: { acceptAllTemplates: false } },
          device: { settings: { acceptAllTemplates: false } },
        },
      };
      expect(await (await get(app, env, '/dto', scanner.headers)).json()).toMatchObject(unassigned);
      expect(
        await pairedSession(createServiceContext(env, { clock }), scanner.id, scannerCsrf(scanner)),
      ).toMatchObject(unassigned);
    },
  );
});
