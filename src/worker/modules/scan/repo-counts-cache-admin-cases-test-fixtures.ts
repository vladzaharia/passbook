import { expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { planCounts } from './counts.ts';
import { adminFor, cache, expectBlocked, kit, scenario } from './repo-counts-cache-fixtures.ts';

export function registerCountsCacheAdminCases() {
  it('returns an explicit admin subset count without caching it for the whole event', async () => {
    const s = await scenario();
    await kit.scanPass(s.otherTemplateId);
    const actor = await adminFor(s, true);
    const plan = planCounts(kit.ctx, actor);
    expect((await plan.read(await kit.env.DB.batch(plan.stmts))).counts.event?.expected).toBe(1);
    expect(await cache(s.event.id)).toEqual({ expected: 73, expected_at: 0 });
  });

  it('caches an explicit full-event selection and fences its admin credential', async () => {
    const s = await scenario();
    const actor = await adminFor(s);
    actor.adminEventTemplates = false;
    const plan = planCounts(kit.ctx, actor);
    expect((await plan.read(await kit.env.DB.batch(plan.stmts))).counts.event?.expected).toBe(1);
    expect(await cache(s.event.id)).toEqual({ expected: 1, expected_at: kit.clock.now() });
    await run(kit.env.DB, 'UPDATE scan_events SET expected=73,expected_at=0 WHERE id=?', [
      s.event.id,
    ]);
    await expectBlocked(
      s,
      (db) =>
        run(db, 'UPDATE sessions SET revoked_at=1 WHERE id_hash=?', [actor.platformSessionId]),
      actor,
    );
  });

  // Session roles and amr are immutable (0047): there is no role change to refuse. The trigger
  // tests in platform/authority-immutable.test.ts cover that the edit itself is rejected.
  it.each(['user', 'selected template'] as const)(
    'does not cache after admin %s authority changes',
    async (change) => {
      const s = await scenario();
      const actor = await adminFor(s);
      await expectBlocked(
        s,
        (db) => {
          if (change === 'selected template')
            return run(db, "UPDATE templates SET status='deleted' WHERE id=?", [s.templateId]);
          return run(db, "UPDATE users SET status='disabled' WHERE id=?", [actor.actor.id]);
        },
        actor,
        undefined,
        change === 'selected template' ? 0 : 1,
      );
    },
  );
}
