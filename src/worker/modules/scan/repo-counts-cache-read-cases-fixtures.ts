import { expect, it } from 'vitest';
import { makePass } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { scannerActor, withRole } from './actor.ts';
import { planCounts } from './counts.ts';
import {
  adminFor,
  cache,
  csrfFence,
  kit,
  raceCache,
  scenario,
  withMutableTrigger,
} from './repo-counts-cache-fixtures.ts';
import { getScanner, scannerEpochsOf } from './repo-device.ts';
import { readScannerScope } from './repo-scope.ts';
import { scanEpochsOf, setScanEpochs } from './scan-epochs.ts';
import { proofedScanActor } from './test-kit.ts';

export function registerCountsCacheReadCases() {
  it('recomputes current event counts on every read and refreshes the cache', async () => {
    const s = await scenario();
    const read = async () => {
      const plan = planCounts(kit.ctx, s.actor);
      return plan.read(await kit.env.DB.batch(plan.stmts));
    };
    expect((await read()).counts.event).toMatchObject({ expected: 1, arrived: 0, inside: null });
    expect(await cache(s.event.id)).toEqual({ expected: 1, expected_at: kit.clock.now() });
    await kit.scanPass(s.templateId);
    expect((await read()).counts.event?.expected).toBe(2);
    kit.clock.advance(61_000);
    expect((await read()).counts.event?.expected).toBe(2);
    expect(await cache(s.event.id)).toEqual({ expected: 2, expected_at: kit.clock.now() });
  });

  it('reads admission counts without an event cache statement', async () => {
    const s = await scenario({ admission: true });
    const plan = planCounts(kit.ctx, s.actor);
    expect(plan.stmts).toHaveLength(2);
    expect((await plan.read(await kit.env.DB.batch(plan.stmts))).counts.event).toBeNull();
    expect(await cache(s.event.id)).toEqual({ expected: 73, expected_at: 0 });
  });

  it('does not overwrite a newer cache committed before its batch', async () => {
    const s = await scenario();
    const asOf = kit.clock.now();
    const race = raceCache((db) =>
      run(db, 'UPDATE scan_events SET expected=9,expected_at=? WHERE id=?', [asOf + 1, s.event.id]),
    );
    const plan = planCounts(race.ctx, s.actor);
    const results = await race.ctx.env.DB.batch(plan.stmts);
    expect(race.raced()).toBe(true);
    expect(results[3]?.results).toEqual([]);
    expect(results[4]?.results?.[0]).toMatchObject({ n: 1 });
    expect((await plan.read(results)).counts.event?.expected).toBe(1);
    expect(await cache(s.event.id)).toEqual({ expected: 9, expected_at: asOf + 1 });
  });

  it('counts and caches the same current Wallet snapshot after a pre-batch change', async () => {
    const s = await scenario();
    const race = raceCache((db) =>
      run(db, "UPDATE passes SET status='voided' WHERE id=?", [s.passId]),
    );
    const plan = planCounts(race.ctx, s.actor);
    const results = await race.ctx.env.DB.batch(plan.stmts);
    expect(race.raced()).toBe(true);
    expect(results[3]?.results?.[0]).toMatchObject({ n: 0 });
    expect(results[4]?.results?.[0]).toMatchObject({ n: null });
    expect((await plan.read(results)).counts.event?.expected).toBe(0);
    expect(await cache(s.event.id)).toEqual({ expected: 0, expected_at: kit.clock.now() });
  });

  it('retains the committed count and cache after a later Wallet change', async () => {
    const s = await scenario();
    const plan = planCounts(kit.ctx, s.actor);
    const asOf = kit.clock.now();
    const results = await kit.env.DB.batch(plan.stmts);
    await run(kit.env.DB, "UPDATE passes SET status='voided' WHERE id=?", [s.passId]);
    expect((await plan.read(results)).counts.event?.expected).toBe(1);
    expect(await cache(s.event.id)).toEqual({ expected: 1, expected_at: asOf });
    const next = planCounts(kit.ctx, s.actor);
    expect((await next.read(await kit.env.DB.batch(next.stmts))).counts.event?.expected).toBe(0);
    expect(await cache(s.event.id)).toEqual({ expected: 0, expected_at: asOf });
  });

  it('captures the event selection, rule and extra fence before lazy batch assembly', async () => {
    const s = await scenario();
    if (!s.actor.event) throw new Error('Missing actor event');
    const actor = {
      ...s.actor,
      event: { ...s.actor.event },
      templateIds: [...s.actor.templateIds],
    };
    const fence = await csrfFence(actor);
    const plan = planCounts(kit.ctx, actor, undefined, actor, fence);
    actor.event.matchInput = 'tier';
    actor.event.matchValues = '["gold"]';
    actor.templateIds[0] = s.otherTemplateId;
    fence.params[0] = 'different-scanner';
    expect((await plan.read(await kit.env.DB.batch(plan.stmts))).counts.event?.expected).toBe(1);
    expect(await cache(s.event.id)).toEqual({ expected: 1, expected_at: kit.clock.now() });
  });

  it('recomputes pass expiry against the injected clock on each read', async () => {
    const s = await scenario();
    const expiring = await kit.scanPass(s.templateId);
    await run(
      kit.env.DB,
      "UPDATE pass_versions SET pass_json=json_set(pass_json,'$.expirationDate',?) WHERE pass_id=?",
      [new Date(kit.clock.now() + 5_000).toISOString(), expiring.id],
    );
    const read = async () => {
      const plan = planCounts(kit.ctx, s.actor);
      return plan.read(await kit.env.DB.batch(plan.stmts));
    };
    expect((await read()).counts.event?.expected).toBe(2);
    kit.clock.advance(5_000);
    expect((await read()).counts.event?.expected).toBe(2);
    const plannedAt = kit.clock.now();
    const pending = planCounts(kit.ctx, s.actor);
    const afterExpiry = planCounts(kit.ctx, s.actor);
    const results = await kit.env.DB.batch(pending.stmts);
    kit.clock.advance(1);
    const captured = await pending.read(results);
    expect(captured.counts.event?.expected).toBe(2);
    expect(captured.counts.asOf).toBe(plannedAt);
    expect(await cache(s.event.id)).toEqual({ expected: 2, expected_at: plannedAt });
    const fresh = await afterExpiry.read(await kit.env.DB.batch(afterExpiry.stmts));
    expect(fresh.counts.event?.expected).toBe(1);
    expect(fresh.counts.asOf).toBe(kit.clock.now());
    expect(await cache(s.event.id)).toEqual({ expected: 1, expected_at: kit.clock.now() });
  });

  it('uses the assembled clock snapshot when time advances just before the batch', async () => {
    const s = await scenario();
    const asOf = kit.clock.now();
    await run(
      kit.env.DB,
      "UPDATE pass_versions SET pass_json=json_set(pass_json,'$.expirationDate',?) WHERE pass_id=?",
      [new Date(asOf + 1_000).toISOString(), s.passId],
    );
    const race = raceCache(async () => {
      kit.clock.advance(2_000);
    });
    const plan = planCounts(race.ctx, s.actor);
    const results = await race.ctx.env.DB.batch(plan.stmts);
    expect(race.raced()).toBe(true);
    const captured = await plan.read(results);
    expect(captured.counts.event?.expected).toBe(1);
    expect(captured.counts.asOf).toBe(asOf);
    expect(await cache(s.event.id)).toEqual({ expected: 1, expected_at: asOf });
    const fresh = planCounts(kit.ctx, s.actor);
    expect((await fresh.read(await kit.env.DB.batch(fresh.stmts))).counts.event?.expected).toBe(0);
    expect(await cache(s.event.id)).toEqual({ expected: 0, expected_at: kit.clock.now() });
  });

  it.each(['event', 'selected'] as const)(
    'recomputes without caching when a legacy-only template is in the %s scope',
    async (kind) => {
      const s = await scenario();
      const legacyId = await kit.scanTemplate(
        'Legacy count',
        {
          actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }],
        },
        { releaseModes: [] },
      );
      const template = await kit.registry.resolve(legacyId);
      const addLegacy = async () => {
        const pass = await makePass(kit.fx, { orgId: kit.org.id, template });
        await run(kit.env.DB, 'UPDATE pass_versions SET pass_json=? WHERE pass_id=?', [
          JSON.stringify({
            ...template.passJson,
            serialNumber: pass.serial,
            passTypeIdentifier: kit.env.PLATFORM_PASS_TYPE_ID,
            teamIdentifier: kit.env.PLATFORM_TEAM_ID,
          }),
          pass.id,
        ]);
      };
      await addLegacy();
      await run(kit.env.DB, 'UPDATE templates SET active_version=NULL WHERE id=?', [legacyId]);
      const actor = await adminFor(s, kind === 'selected');
      if (kind === 'event') {
        await run(
          kit.env.DB,
          'INSERT INTO scan_event_templates (event_id,template_id) VALUES (?,?)',
          [s.event.id, legacyId],
        );
        actor.templateIds = [s.templateId, legacyId];
      } else {
        actor.templateIds = [legacyId];
      }
      await run(kit.env.DB, 'UPDATE scan_events SET expected=73,expected_at=? WHERE id=?', [
        kit.clock.now(),
        s.event.id,
      ]);
      const read = async () => {
        const plan = planCounts(kit.ctx, actor);
        const results = await kit.env.DB.batch(plan.stmts);
        expect(results[3]?.results).toEqual([]);
        return plan.read(results);
      };
      expect((await read()).counts.event?.expected).toBe(kind === 'event' ? 2 : 1);
      await addLegacy();
      expect((await read()).counts.event?.expected).toBe(kind === 'event' ? 3 : 2);
      expect(await cache(s.event.id)).toEqual({ expected: 73, expected_at: kit.clock.now() });
    },
  );

  it('recomputes without caching when the current release head is malformed', async () => {
    const s = await scenario();
    const db = kit.env.DB;
    const head = await first<{ id: string; generation: number }>(
      db,
      `SELECT id,generation
      FROM template_releases WHERE template_id=? AND org_id=? AND mode='live' AND provider='apple'
      ORDER BY generation DESC LIMIT 1`,
      [s.templateId, kit.org.id],
    );
    if (!head) throw new Error('Missing release head fixture');
    await run(db, 'UPDATE scan_events SET expected=73,expected_at=? WHERE id=?', [
      kit.clock.now(),
      s.event.id,
    ]);
    await withMutableTrigger('template_releases_immutable', async () => {
      try {
        const race = raceCache((target) =>
          run(target, 'UPDATE template_releases SET generation=9007199254740992 WHERE id=?', [
            head.id,
          ]),
        );
        const plan = planCounts(race.ctx, s.actor);
        const results = await race.ctx.env.DB.batch(plan.stmts);
        expect(race.raced()).toBe(true);
        expect(results[3]?.results).toEqual([]);
        expect((await plan.read(results)).counts.event?.expected).toBe(1);
        expect(await cache(s.event.id)).toEqual({ expected: 73, expected_at: kit.clock.now() });
      } finally {
        await run(db, 'UPDATE template_releases SET generation=? WHERE id=?', [
          head.generation,
          head.id,
        ]);
      }
    });
  });

  it('counts only current eligible passes for the event mode', async () => {
    const templateId = await kit.scanTemplate('Count eligibility', {
      actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }],
    });
    await kit.scanPass(templateId, {}, { mode: 'test' });
    const live = await kit.scanPass(templateId, {}, { mode: 'live' });
    const wrongIssuance = await kit.scanPass(templateId, {}, { mode: 'test' });
    await run(kit.env.DB, 'UPDATE passes SET release_id=? WHERE id=?', [
      live.releaseId,
      wrongIssuance.id,
    ]);
    for (const set of [
      "status='voided'",
      'removed_at=1',
      'deleted_at=1',
      'test_data_quarantined=1',
    ]) {
      const pass = await kit.scanPass(templateId, {}, { mode: 'test' });
      await run(kit.env.DB, `UPDATE passes SET ${set} WHERE id=?`, [pass.id]);
    }
    const event = await kit.event({ mode: 'test', templateIds: [templateId] });
    const scanner = await kit.scanner({ mode: 'test', eventId: event.id });
    const row = await getScanner(kit.env.DB, scanner.id);
    if (!row) throw new Error('Missing scanner fixture');
    const scope = await readScannerScope(kit.env.DB, row, null);
    const actor = await proofedScanActor(
      kit.ctx,
      withRole(scannerActor(kit.ctx, row, 'test', 'cookie', scope), null),
    );
    const plan = planCounts(kit.ctx, actor);
    expect((await plan.read(await kit.env.DB.batch(plan.stmts))).counts.event?.expected).toBe(1);
    expect(await cache(event.id)).toEqual({ expected: 1, expected_at: kit.clock.now() });
  });

  it('refreshes for a current signed-in operator in an active scanning session', async () => {
    const s = await scenario({ staff: true, session: true });
    const plan = planCounts(kit.ctx, s.actor);
    expect((await plan.read(await kit.env.DB.batch(plan.stmts))).counts.event?.expected).toBe(1);
    expect(await cache(s.event.id)).toEqual({ expected: 1, expected_at: kit.clock.now() });
  });

  it('refreshes for a current admin using all event templates', async () => {
    const s = await scenario();
    const actor = await adminFor(s);
    const plan = planCounts(kit.ctx, actor);
    expect((await plan.read(await kit.env.DB.batch(plan.stmts))).counts.event?.expected).toBe(1);
    expect(await cache(s.event.id)).toEqual({ expected: 1, expected_at: kit.clock.now() });
  });

  it('captures credential expiry at batch assembly, not after the batch has committed', async () => {
    const s = await scenario();
    if (!s.actor.scanner) throw new Error('Missing scanner snapshot');
    const expiresAt = kit.clock.now() + 1_000;
    await run(kit.env.DB, 'UPDATE scanners SET expires_at=? WHERE id=?', [expiresAt, s.scanner.id]);
    const actor = { ...s.actor, scanner: { ...s.actor.scanner, expiresAt } };
    // The expiry change is a credential epoch bump: the actor is the one observed after it.
    const moved = await getScanner(kit.env.DB, s.scanner.id);
    const epochs = scanEpochsOf(s.actor);
    if (!moved || !epochs?.scanner) throw new Error('Missing scanner epochs');
    setScanEpochs(actor, { ...epochs, scanner: { ...epochs.scanner, ...scannerEpochsOf(moved) } });
    const committed = planCounts(kit.ctx, actor);
    const pending = planCounts(kit.ctx, actor);
    const asOf = kit.clock.now();
    const results = await kit.env.DB.batch(committed.stmts);
    kit.clock.advance(2_000);
    const captured = await committed.read(results);
    expect(captured.counts.event?.expected).toBe(1);
    expect(captured.counts.asOf).toBe(asOf);
    expect(await cache(s.event.id)).toEqual({ expected: 1, expected_at: asOf });
    await run(kit.env.DB, 'UPDATE scan_events SET expected=73,expected_at=0 WHERE id=?', [
      s.event.id,
    ]);
    const expired = await pending.read(await kit.env.DB.batch(pending.stmts));
    expect(expired.counts.event?.expected).toBe(1);
    expect(expired.counts.asOf).toBe(kit.clock.now());
    expect(await cache(s.event.id)).toEqual({ expected: 73, expected_at: 0 });
  });
}
