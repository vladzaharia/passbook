import type { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type makeEnv,
  makeOrg,
  makeScanEvent,
  makeScanner,
  makeScanStaff,
  makeTemplate,
} from '../../../../test/helpers/index.ts';
import type { AppBindings } from '../../platform/context.ts';
import { run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createGuardHarness, get, scannerCsrf } from './guard-test-fixtures.ts';
import { pairedSession } from './pairing-session.ts';
import { readScannerScope, readValidEventScope } from './repo-scope.ts';

const harness = createGuardHarness();
let { f, clock, orgId } = harness;
const { persistApprovedTemplate } = harness;
const build: typeof harness.build = async (...args) => {
  const result = await harness.build(...args);
  ({ f, clock, orgId } = harness);
  return result;
};

describe('requireScanActor: scope: pinned events', () => {
  let app: Hono<AppBindings>;
  let env: Awaited<ReturnType<typeof makeEnv>>;
  beforeEach(async () => {
    ({ app, env } = await build());
  });

  it('retains valid event and explicit template scopes without accepting all', async () => {
    const a = makeTemplate({ id: f.ids.id(), orgId });
    const b = makeTemplate({ id: f.ids.id(), orgId });
    const gone = makeTemplate({ id: f.ids.id(), orgId });
    for (const t of [a, b, gone]) await persistApprovedTemplate(t);
    await run(env.DB, "UPDATE templates SET status = 'archived' WHERE id = ?", [b.resolved.id]);
    await run(env.DB, "UPDATE templates SET status = 'deleted' WHERE id = ?", [gone.resolved.id]);
    const ev = await makeScanEvent(f, {
      orgId,
      templateIds: [a.resolved.id, b.resolved.id],
    });
    await run(
      env.DB,
      "UPDATE scan_events SET match_input = 'memberName', match_values = '[\"Alex\"]' WHERE id = ?",
      [ev.id],
    );
    const s = await makeScanner(f, {
      orgId,
      eventId: ev.id,
      templateIds: [b.resolved.id],
      settings: { acceptAllTemplates: true },
    });
    expect(await (await get(app, env, '/ping', s.headers)).json()).toMatchObject({
      event: { id: ev.id },
      templateIds: [a.resolved.id, b.resolved.id].sort(),
      settings: { acceptAllTemplates: false },
      invalidScannerScope: false,
    });
    expect(await readValidEventScope(env.DB, orgId, 'live', ev.id)).toMatchObject({
      event: { id: ev.id },
      templateIds: [a.resolved.id, b.resolved.id].sort(),
    });
    expect(await (await get(app, env, '/dto', s.headers)).json()).toMatchObject({
      state: 'ready',
      event: { id: ev.id },
      scanner: { settings: { acceptAllTemplates: false } },
    });
    expect(
      await pairedSession(createServiceContext(env, { clock }), s.id, scannerCsrf(s)),
    ).toMatchObject({
      state: 'ready',
      event: { id: ev.id },
      scanner: { settings: { acceptAllTemplates: false } },
    });
    const own = await makeScanner(f, {
      orgId,
      templateIds: [b.resolved.id, gone.resolved.id],
      settings: { acceptAllTemplates: true },
    });
    expect(await (await get(app, env, '/ping', own.headers)).json()).toMatchObject({
      event: null,
      templateIds: [],
      settings: { acceptAllTemplates: false },
      invalidScannerScope: true,
    });
    expect(
      await pairedSession(createServiceContext(env, { clock }), own.id, scannerCsrf(own)),
    ).toMatchObject({
      state: 'unassigned',
      scanner: { settings: { acceptAllTemplates: false } },
    });
    const allScanner = await makeScanner(f, { orgId, settings: { acceptAllTemplates: true } });
    expect(
      await pairedSession(
        createServiceContext(env, { clock }),
        allScanner.id,
        scannerCsrf(allScanner),
      ),
    ).toMatchObject({ state: 'ready', scanner: { settings: { acceptAllTemplates: true } } });
  });

  it('treats an explicit empty event id as invalid rather than absent', async () => {
    const template = makeTemplate({ id: f.ids.id(), orgId });
    await persistApprovedTemplate(template);
    const scanner = await makeScanner(f, { orgId, templateIds: [template.resolved.id] });
    const staff = await makeScanStaff(f, { orgId, role: 'desk' });
    expect(
      await readScannerScope(env.DB, { id: scanner.id, orgId, mode: 'live', eventId: '' }, null),
    ).toMatchObject({ event: null, templateIds: [], restricted: true, valid: false });
    expect(
      await readScannerScope(
        env.DB,
        { id: scanner.id, orgId, mode: 'live', eventId: '' },
        staff.id,
      ),
    ).toMatchObject({ event: null, templateIds: [], valid: false, staff: { id: staff.id } });
  });

  it.each(['empty', 'overlong'] as const)(
    'rejects a %s event id even when it names a matching event row',
    async (kind) => {
      const template = makeTemplate({ id: f.ids.id(), orgId });
      await persistApprovedTemplate(template);
      const eventId = kind === 'empty' ? '' : f.ids.id().padEnd(65, 'x');
      const now = clock.now();
      await run(
        env.DB,
        `INSERT INTO scan_events
          (id,org_id,mode,name,opens_at,closes_at,time_zone,created_at,updated_at)
         VALUES (?,?,'live','Invalid id',?,?,'UTC',?,?)`,
        [eventId, orgId, now - 1000, now + 1000, now, now],
      );
      await run(env.DB, 'INSERT INTO scan_event_templates (event_id, template_id) VALUES (?, ?)', [
        eventId,
        template.resolved.id,
      ]);
      const scanner = await makeScanner(f, {
        orgId,
        eventId,
        templateIds: [template.resolved.id],
        settings: { acceptAllTemplates: true },
      });
      expect(await readValidEventScope(env.DB, orgId, 'live', eventId)).toBeNull();
      expect(await (await get(app, env, '/ping', scanner.headers)).json()).toMatchObject({
        event: null,
        templateIds: [],
        settings: { acceptAllTemplates: false },
        invalidScannerScope: true,
      });
      expect(await (await get(app, env, '/dto', scanner.headers)).json()).toMatchObject({
        state: 'unassigned',
        event: null,
        templates: [],
        scanner: { settings: { acceptAllTemplates: false } },
      });
    },
  );

  it.each(['missing', 'archived', 'wrong-mode', 'foreign-org'] as const)(
    'denies a %s pinned event in the guard, session, and pairing projections',
    async (reason) => {
      const own = makeTemplate({ id: f.ids.id(), orgId });
      const eventTemplate = makeTemplate({ id: f.ids.id(), orgId });
      await persistApprovedTemplate(own);
      await persistApprovedTemplate(eventTemplate);
      const foreign = reason === 'foreign-org' ? await makeOrg(f) : null;
      const ev = await makeScanEvent(f, {
        orgId: foreign?.id ?? orgId,
        mode: reason === 'wrong-mode' ? 'test' : 'live',
        templateIds: [eventTemplate.resolved.id],
      });
      const scanner = await makeScanner(f, {
        orgId,
        eventId: ev.id,
        templateIds: [own.resolved.id],
        settings: { acceptAllTemplates: true },
      });
      if (reason === 'archived')
        await run(env.DB, 'UPDATE scan_events SET archived_at = 1 WHERE id = ?', [ev.id]);

      // The schema normally nulls event_id on deletion; simulate a stale/missing event read.
      const original = env.DB;
      if (reason === 'missing') {
        expect(await readValidEventScope(original, orgId, 'live', f.ids.id())).toBeNull();
        Object.assign(env, {
          DB: new Proxy(original, {
            get(target, prop) {
              if (prop === 'prepare')
                return (sql: string) =>
                  target.prepare(
                    sql.includes('FROM scan_events WHERE id = ? AND org_id = ?')
                      ? `${sql} AND 0`
                      : sql,
                  );
              const value = Reflect.get(target, prop, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          }),
        });
      }
      try {
        expect(await readValidEventScope(env.DB, orgId, 'live', ev.id)).toBeNull();
        const ping = await get(app, env, '/ping', scanner.headers);
        expect(ping.status).toBe(200);
        expect(await ping.json()).toMatchObject({
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
        const dto = await get(app, env, '/dto', scanner.headers);
        expect(await dto.json()).toMatchObject({
          state: 'unassigned',
          event: null,
          templates: [],
          formats: [],
          scanner: { settings: { acceptAllTemplates: false } },
        });
        expect(
          await pairedSession(
            createServiceContext(env, { clock }),
            scanner.id,
            scannerCsrf(scanner),
          ),
        ).toMatchObject({
          state: 'unassigned',
          event: null,
          templates: [],
          formats: [],
          scanner: { settings: { acceptAllTemplates: false } },
        });
      } finally {
        Object.assign(env, { DB: original });
      }
    },
  );
});
