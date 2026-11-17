import { expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { scannerActor, withRole } from './actor.ts';
import { planCounts } from './counts.ts';
import {
  adminFor,
  cache,
  csrfFence,
  kit,
  raceCache,
  scenario,
} from './repo-counts-cache-fixtures.ts';
import { getScanner } from './repo-device.ts';
import { readScannerScope } from './repo-scope.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import { proofedScanActor } from './test-kit.ts';

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

  // An admission selects the event of the pass it scans: the guard captured no epoch for it, so
  // it is counted live and its cache is never written.
  it.each([false, true])(
    'counts an admission-selected event without writing its cache (session=%s)',
    async (session) => {
      const s = await scenario({ admission: true, session });
      const countedActor = { ...s.actor, event: s.event };
      for (const guard of [undefined, await csrfFence(s.actor)]) {
        const plan = planCounts(kit.ctx, countedActor, undefined, s.actor, guard);
        expect(plan.stmts).toHaveLength(4);
        expect((await plan.read(await kit.env.DB.batch(plan.stmts))).counts.event?.expected).toBe(
          1,
        );
        expect(await cache(s.event.id)).toEqual({ expected: 73, expected_at: 0 });
      }
    },
  );

  it.each([false, true])(
    'counts an admission-selected event over its own template list (session=%s)',
    async (session) => {
      const s = await scenario({ admission: true, session });
      await run(kit.env.DB, 'UPDATE scan_event_templates SET template_id=? WHERE event_id=?', [
        s.otherTemplateId,
        s.event.id,
      ]);
      const countedActor = { ...s.actor, event: s.event, templateIds: [s.otherTemplateId] };
      const plan = planCounts(kit.ctx, countedActor, undefined, s.actor);
      expect((await plan.read(await kit.env.DB.batch(plan.stmts))).counts.event?.expected).toBe(0);
      expect(await cache(s.event.id)).toEqual({ expected: 73, expected_at: 0 });
    },
  );

  it.each([false, true])(
    'counts unscoped admission counts without a cache write when accept-all is %s',
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
    },
  );

  it('does not cache a counted event whose selection moved after the actor captured it', async () => {
    const s = await scenario();
    const race = raceCache((db) =>
      run(db, 'INSERT INTO scan_event_templates (event_id,template_id) VALUES (?,?)', [
        s.event.id,
        s.otherTemplateId,
      ]),
    );
    const plan = planCounts(race.ctx, s.actor);
    const results = await race.ctx.env.DB.batch(plan.stmts);
    expect(race.raced()).toBe(true);
    expect(results[3]?.results).toEqual([]);
    // The count is the actor's own selection; only the event's cache is refused.
    expect((await plan.read(results)).counts.event?.expected).toBe(1);
    expect(await cache(s.event.id)).toEqual({ expected: 73, expected_at: 0 });
  });
}
