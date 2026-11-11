import { expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { scannerActor, withRole } from './actor.ts';
import { planCounts } from './counts.ts';
import {
  adminFor,
  cache,
  csrfFence,
  expectBlocked,
  kit,
  raceCache,
  scenario,
  withMutableTrigger,
} from './repo-counts-cache-fixtures.ts';
import { getScanner } from './repo-device.ts';
import { readScannerScope } from './repo-scope.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import { makeLegacyScanPass, proofedScanActor } from './test-kit.ts';

export function registerCountsCacheScopeCases() {
  it('fences implicitly selected admin templates even if changed before the counts batch', async () => {
    const s = await scenario();
    const actor = await adminFor(s);
    const plan = planCounts(kit.ctx, actor);
    await run(kit.env.DB, 'INSERT INTO scan_event_templates (event_id,template_id) VALUES (?,?)', [
      s.event.id,
      s.otherTemplateId,
    ]);
    expect((await plan.read(await kit.env.DB.batch(plan.stmts))).counts.event?.expected).toBe(1);
    expect(await cache(s.event.id)).toEqual({ expected: 73, expected_at: 0 });
  });

  it('fences the counted event snapshot even when the authority actor has the same event id', async () => {
    const s = await scenario();
    const countedActor = {
      ...s.actor,
      event: { ...s.event, matchInput: 'tier', matchValues: '["gold"]' },
    };
    const plan = planCounts(kit.ctx, countedActor, undefined, s.actor);
    expect((await plan.read(await kit.env.DB.batch(plan.stmts))).counts.event?.expected).toBe(0);
    expect(await cache(s.event.id)).toEqual({ expected: 73, expected_at: 0 });
  });

  it.each([false, true])(
    'refreshes admission-selected event counts using the original actor scope (session=%s)',
    async (session) => {
      const s = await scenario({ admission: true, session });
      const countedActor = { ...s.actor, event: s.event };
      for (const guarded of [false, true]) {
        const guard = guarded ? await csrfFence(s.actor) : undefined;
        const plan = planCounts(kit.ctx, countedActor, undefined, s.actor, guard);
        expect((await plan.read(await kit.env.DB.batch(plan.stmts))).counts.event?.expected).toBe(
          1,
        );
        expect(await cache(s.event.id)).toEqual({ expected: 1, expected_at: kit.clock.now() });
      }
    },
  );

  it.each([false, true])(
    'checks the original admission release independently of the counted event (session=%s)',
    async (session) => {
      const s = await scenario({ admission: true, session });
      await run(kit.env.DB, 'UPDATE scan_event_templates SET template_id=? WHERE event_id=?', [
        s.otherTemplateId,
        s.event.id,
      ]);
      const countedActor = { ...s.actor, event: s.event, templateIds: [s.otherTemplateId] };
      const plan = planCounts(kit.ctx, countedActor, undefined, s.actor);
      expect((await plan.read(await kit.env.DB.batch(plan.stmts))).counts.event?.expected).toBe(0);
      expect(await cache(s.event.id)).toEqual({ expected: 0, expected_at: kit.clock.now() });
      await run(kit.env.DB, 'UPDATE scan_events SET expected=73,expected_at=0 WHERE id=?', [
        s.event.id,
      ]);
      await expectBlocked(
        s,
        (db) =>
          withMutableTrigger('template_releases_immutable', () =>
            run(
              db,
              `UPDATE template_releases SET adapter_revision=adapter_revision+100
               WHERE template_id=? AND mode='live'`,
              [s.templateId],
            ),
          ),
        countedActor,
        s.actor,
        0,
      );
    },
  );

  it.each([false, true])(
    'requires a valid legacy Wallet in the original admission scope (session=%s)',
    async (session) => {
      const s = await scenario({ admission: true, session });
      const legacyId = await kit.scanTemplate(
        'Legacy admission scope',
        { actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }] },
        { releaseModes: [] },
      );
      const legacy = await makeLegacyScanPass(kit.fx, {
        orgId: kit.org.id,
        template: await kit.registry.resolve(legacyId),
      });
      await run(kit.env.DB, 'UPDATE scanner_templates SET template_id=? WHERE scanner_id=?', [
        legacyId,
        s.scanner.id,
      ]);
      if (session)
        await run(kit.env.DB, 'UPDATE scanning_sessions SET accepts=? WHERE id=?', [
          JSON.stringify({ templateIds: [legacyId] }),
          s.sessionId,
        ]);
      const scanner = await getScanner(kit.env.DB, s.scanner.id);
      if (!scanner) throw new Error('Missing scanner fixture');
      const scope = await readScannerScope(kit.env.DB, scanner, null);
      const observed = scannerActor(kit.ctx, scanner, 'live', 'cookie', scope);
      if (session) await bindScanningSession(kit.ctx, observed);
      const actor = await proofedScanActor(kit.ctx, withRole(observed, null));
      const countedActor = { ...actor, event: s.event, templateIds: [s.templateId] };
      const plan = planCounts(kit.ctx, countedActor, undefined, actor);
      expect((await plan.read(await kit.env.DB.batch(plan.stmts))).counts.event?.expected).toBe(1);
      expect(await cache(s.event.id)).toEqual({ expected: 1, expected_at: kit.clock.now() });
      await run(kit.env.DB, 'UPDATE scan_events SET expected=73,expected_at=0 WHERE id=?', [
        s.event.id,
      ]);
      await expectBlocked(
        s,
        (db) => run(db, "UPDATE pass_versions SET pass_json='{}' WHERE pass_id=?", [legacy.id]),
        countedActor,
        actor,
      );
    },
  );

  it.each([false, true])(
    'does not cache unscoped admission counts when accept-all changes from %s',
    async (acceptAll) => {
      const s = await scenario({ admission: true, session: true });
      await run(kit.env.DB, 'DELETE FROM scanner_templates WHERE scanner_id=?', [s.scanner.id]);
      await run(
        kit.env.DB,
        `UPDATE scanning_sessions SET accepts=NULL,
        settings=json_set(settings,'$.acceptAllTemplates',json(?)) WHERE id=?`,
        [JSON.stringify(acceptAll), s.sessionId],
      );
      const scanner = await getScanner(kit.env.DB, s.scanner.id);
      if (!scanner) throw new Error('Missing scanner fixture');
      const scope = await readScannerScope(kit.env.DB, scanner, null);
      const observed = scannerActor(kit.ctx, scanner, 'live', 'cookie', scope);
      await bindScanningSession(kit.ctx, observed);
      const actor = await proofedScanActor(kit.ctx, withRole(observed, null));
      const countedActor = { ...actor, event: s.event };
      const current = planCounts(kit.ctx, countedActor, undefined, actor);
      expect(
        (await current.read(await kit.env.DB.batch(current.stmts))).counts.event?.expected,
      ).toBe(0);
      expect(await cache(s.event.id)).toEqual({ expected: 73, expected_at: 0 });
      await run(kit.env.DB, 'UPDATE scan_events SET expected=73,expected_at=0 WHERE id=?', [
        s.event.id,
      ]);
      const race = raceCache((db) =>
        run(
          db,
          `UPDATE scanning_sessions SET
        settings=json_set(settings,'$.acceptAllTemplates',json(?)) WHERE id=?`,
          [JSON.stringify(!acceptAll), s.sessionId],
        ),
      );
      const plan = planCounts(race.ctx, countedActor, undefined, actor);
      expect(
        (await plan.read(await race.ctx.env.DB.batch(plan.stmts))).counts.event?.expected,
      ).toBe(0);
      expect(race.raced()).toBe(true);
      expect(await cache(s.event.id)).toEqual({ expected: 73, expected_at: 0 });
    },
  );

  it('rejects malformed template scope on an admission-selected event', async () => {
    const s = await scenario({ admission: true, session: true });
    const countedActor = { ...s.actor, event: s.event };
    await expectBlocked(
      s,
      (db) =>
        run(db, 'UPDATE scanning_sessions SET accepts=? WHERE id=?', [
          JSON.stringify({ templateIds: [s.templateId], extra: true }),
          s.sessionId,
        ]),
      countedActor,
      s.actor,
    );
  });

  it.each([false, true])(
    'fences a changed admission actor template scope (session=%s)',
    async (session) => {
      const s = await scenario({ admission: true, session });
      const countedActor = { ...s.actor, event: s.event };
      await expectBlocked(
        s,
        (db) =>
          session
            ? run(db, 'UPDATE scanning_sessions SET accepts=? WHERE id=?', [
                JSON.stringify({ templateIds: [s.otherTemplateId] }),
                s.sessionId,
              ])
            : run(db, 'INSERT INTO scanner_templates (scanner_id,template_id) VALUES (?,?)', [
                s.scanner.id,
                s.otherTemplateId,
              ]),
        countedActor,
        s.actor,
      );
    },
  );

  it.each([false, true])(
    'checks every current admission release with a malformed captured list (session=%s)',
    async (session) => {
      const s = await scenario({ admission: true, session });
      const countedActor = { ...s.actor, event: s.event };
      const authority = {
        ...s.actor,
        templateIds: [s.templateId, null] as unknown as string[],
      };
      await expectBlocked(
        s,
        async (db) => {
          if (session)
            await run(db, 'UPDATE scanning_sessions SET accepts=? WHERE id=?', [
              JSON.stringify({ templateIds: [s.templateId, s.otherTemplateId] }),
              s.sessionId,
            ]);
          else
            await run(db, 'INSERT INTO scanner_templates (scanner_id,template_id) VALUES (?,?)', [
              s.scanner.id,
              s.otherTemplateId,
            ]);
          await withMutableTrigger('template_releases_immutable', () =>
            run(
              db,
              `UPDATE template_releases SET adapter_revision=adapter_revision+100
               WHERE template_id=? AND mode='live'`,
              [s.otherTemplateId],
            ),
          );
        },
        countedActor,
        authority,
      );
    },
  );
}
