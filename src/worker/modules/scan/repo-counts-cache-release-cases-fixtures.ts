import { expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
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
} from './repo-counts-cache-fixtures.ts';
import { getScanner } from './repo-device.ts';
import { readScannerScope } from './repo-scope.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import { boundStaff } from './staff-binding.ts';
import { approveScanReleases, grantScanMembership, proofedScanActor } from './test-kit.ts';

export function registerCountsCacheReleaseCases() {
  it('does not cache after the captured admin session expires before batch assembly', async () => {
    const s = await scenario();
    const actor = await adminFor(s);
    if (!actor.tenantAuthority) throw new Error('Missing admin authority');
    const expiresAt = actor.tenantAuthority.sessionExpiresAt;
    await run(kit.env.DB, 'UPDATE sessions SET idle_expires_at=? WHERE id_hash=?', [
      expiresAt + 1_000,
      actor.platformSessionId,
    ]);
    const plan = planCounts(kit.ctx, actor);
    kit.clock.set(expiresAt + 1);
    const results = await kit.env.DB.batch(plan.stmts);
    expect(results[3]?.results).toEqual([]);
    const captured = await plan.read(results);
    expect(captured.counts.event?.expected).toBe(1);
    expect(captured.counts.asOf).toBe(expiresAt + 1);
    expect(await cache(s.event.id)).toEqual({ expected: 73, expected_at: 0 });
  });

  it.each(['revoked', 'regranted'] as const)(
    'does not cache after the admin membership is %s',
    async (change) => {
      const s = await scenario();
      const actor = await adminFor(s);
      const authority = actor.tenantAuthority;
      if (!authority) throw new Error('Missing tenant authority');
      await expectBlocked(
        s,
        async (db) => {
          await run(db, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [
            kit.clock.now(),
            authority.membershipId,
          ]);
          if (change === 'regranted') await grantScanMembership(kit.fx, kit.org.id, actor.actor.id);
        },
        actor,
      );
    },
  );

  it('fences event-template changes before an admin counts batch', async () => {
    const s = await scenario();
    const actor = await adminFor(s);
    await expectBlocked(
      s,
      (db) =>
        run(db, 'INSERT INTO scan_event_templates (event_id,template_id) VALUES (?,?)', [
          s.event.id,
          s.otherTemplateId,
        ]),
      actor,
    );
  });

  it.each([false, true])(
    'counts and caches the current event head when it changes before the batch (explicit=%s)',
    async (explicit) => {
      const s = await scenario();
      const actor = await adminFor(s);
      actor.adminEventTemplates = !explicit;
      const race = raceCache((db) =>
        approveScanReleases(kit, s.templateId, { modes: ['live'], db }),
      );
      const plan = planCounts(race.ctx, actor);
      expect(
        (await plan.read(await race.ctx.env.DB.batch(plan.stmts))).counts.event?.expected,
      ).toBe(1);
      expect(race.raced()).toBe(true);
      expect(await cache(s.event.id)).toEqual({ expected: 1, expected_at: kit.clock.now() });
    },
  );

  it('counts and caches against an incompatible release promoted before the batch', async () => {
    const s = await scenario();
    const original = await kit.registry.resolve(s.templateId);
    const next = kit.registry.add({
      id: s.templateId,
      orgId: kit.org.id,
      version: 'v2',
      manifest: original.manifest,
      passJson: original.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await run(
      kit.env.DB,
      `INSERT INTO template_versions
      (template_id,version,manifest,pass_json,assets,report,created_by,created_at,build_key)
      SELECT template_id,?,manifest,pass_json,assets,report,created_by,created_at,?
      FROM template_versions WHERE template_id=? AND version=?`,
      [next.version, 'different-build', s.templateId, original.version],
    );
    const race = raceCache((db) =>
      approveScanReleases(kit, s.templateId, { modes: ['live'], version: next.version, db }),
    );
    const plan = planCounts(race.ctx, s.actor);
    const results = await race.ctx.env.DB.batch(plan.stmts);
    expect(race.raced()).toBe(true);
    expect(results[3]?.results?.[0]).toMatchObject({ n: 0 });
    expect((await plan.read(results)).counts.event?.expected).toBe(0);
    expect(await cache(s.event.id)).toEqual({ expected: 0, expected_at: kit.clock.now() });
  });

  it('does not fence a Live cache write when only the Test release changes', async () => {
    const s = await scenario();
    const race = raceCache((db) => approveScanReleases(kit, s.templateId, { modes: ['test'], db }));
    const plan = planCounts(race.ctx, s.actor);
    expect((await plan.read(await race.ctx.env.DB.batch(plan.stmts))).counts.event?.expected).toBe(
      1,
    );
    expect(race.raced()).toBe(true);
    expect(await cache(s.event.id)).toEqual({ expected: 1, expected_at: kit.clock.now() });
  });

  it('keeps twenty-template scanner and admin cache batches within D1 bind limits', async () => {
    const s = await scenario({ staff: true, session: true });
    if (!s.staff) throw new Error('Missing staff fixture');
    const ids = [s.templateId, s.otherTemplateId];
    for (let i = ids.length; i < 20; i++) {
      ids.push(
        await kit.scanTemplate(
          `Count scope ${i}`,
          {
            actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }],
          },
          { releaseModes: ['live'] },
        ),
      );
    }
    for (const id of ids.slice(1))
      await run(
        kit.env.DB,
        'INSERT INTO scan_event_templates (event_id,template_id) VALUES (?,?)',
        [s.event.id, id],
      );
    const row = await getScanner(kit.env.DB, s.scanner.id);
    if (!row) throw new Error('Missing scanner fixture');
    const scope = await readScannerScope(kit.env.DB, row, s.staff.id);
    const observed = scannerActor(kit.ctx, row, 'live', 'cookie', scope);
    await bindScanningSession(kit.ctx, observed);
    // Column-compared actor: this case measures the packed (no-epoch) fence against the bind cap.
    const scanner = await proofedScanActor(
      kit.ctx,
      withRole(observed, scope.staff ? await boundStaff(kit.ctx, row, scope.staff) : null),
      { epochs: false },
    );
    const admin = await adminFor(s, false, ids);
    const bound: { sql: string; count: number }[] = [];
    const db = new Proxy(kit.env.DB, {
      get(target, prop) {
        if (prop === 'prepare')
          return (sql: string) =>
            new Proxy(target.prepare(sql), {
              get(statement, member) {
                if (member === 'bind')
                  return (...params: unknown[]) => {
                    bound.push({ sql, count: params.length });
                    return statement.bind(...params);
                  };
                const value = Reflect.get(statement, member, statement);
                return typeof value === 'function' ? value.bind(statement) : value;
              },
            });
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const ctx: ServiceContext = { ...kit.ctx, env: { ...kit.env, DB: db } };
    for (const actor of [scanner, admin]) {
      const guard = await csrfFence(actor);
      bound.length = 0;
      const plan = planCounts(ctx, actor, undefined, actor, guard);
      const results = await db.batch(plan.stmts);
      expect(bound.some(({ sql }) => sql.startsWith('UPDATE scan_events SET expected ='))).toBe(
        true,
      );
      expect(bound.some(({ sql }) => sql.startsWith('SELECT CASE WHEN changes()=0'))).toBe(true);
      expect(bound.every(({ count }) => count <= 100)).toBe(true);
      expect(results[3]?.results?.[0]).toMatchObject({ n: 1 });
      expect((await plan.read(results)).counts.event?.expected).toBe(1);
      expect(await cache(s.event.id)).toEqual({ expected: 1, expected_at: kit.clock.now() });
    }
  }, 120_000);

  it('reads the exact count without a cache write when the cache fence exceeds the bind budget', async () => {
    const s = await scenario();
    const csrf = await csrfFence(s.actor);
    const extra = Array.from({ length: 90 }, () => '?/* scan-ephemeral-proof */ IS NOT NULL');
    const guard = {
      sql: `(${csrf.sql}) AND ${extra.join(' AND ')}`,
      params: [...csrf.params, ...extra.map(() => 'overflow-fixture')],
    };
    const plan = planCounts(kit.ctx, s.actor, undefined, s.actor, guard);
    expect(plan.stmts).toHaveLength(4);
    await kit.scanPass(s.templateId);
    const results = await kit.env.DB.batch(plan.stmts);
    expect(results[3]?.results?.[0]).toMatchObject({ n: 2 });
    expect((await plan.read(results)).counts.event?.expected).toBe(2);
    expect(await cache(s.event.id)).toEqual({ expected: 73, expected_at: 0 });

    const ordinary = planCounts(kit.ctx, s.actor, undefined, s.actor, csrf);
    expect(ordinary.stmts).toHaveLength(5);
    expect(
      (await ordinary.read(await kit.env.DB.batch(ordinary.stmts))).counts.event?.expected,
    ).toBe(2);
    expect(await cache(s.event.id)).toEqual({ expected: 2, expected_at: kit.clock.now() });
  });
}
