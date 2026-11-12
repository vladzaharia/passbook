import { describe, expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { expectNoUndo, kit, raceBatch, scenario } from './repo-undo-authority-test-fixtures.ts';
import { PIN_PERSON_WINDOW_MS, PIN_SCANNER_WINDOW_MS } from './staff-pin.ts';
import { key } from './test-kit.ts';
import { undo } from './undo.ts';

const approvalRead = 'FROM scan_staff WHERE id = ? AND org_id = ?';

async function seedBudget(scannerId: string, staffId: string) {
  const now = kit.clock.now();
  const personKey = `scan:pin:${scannerId}:${staffId}`;
  const scannerKey = `scan:pinall:${scannerId}`;
  const personWindow = now - (now % PIN_PERSON_WINDOW_MS);
  const scannerWindow = now - (now % PIN_SCANNER_WINDOW_MS);
  await run(kit.env.DB, 'INSERT INTO counters (key,window_start,count) VALUES (?,?,2)', [
    personKey,
    personWindow,
  ]);
  await run(kit.env.DB, 'INSERT INTO counters (key,window_start,count) VALUES (?,?,3)', [
    scannerKey,
    scannerWindow,
  ]);
  return { personKey, scannerKey, personWindow, scannerWindow };
}

async function pinCounters() {
  return all(
    kit.env.DB,
    "SELECT key,window_start,count FROM counters WHERE key LIKE 'scan:pin%' ORDER BY key,window_start",
  );
}

const heldMarkers = () =>
  first(
    kit.env.DB,
    "SELECT count(*) AS n FROM counters WHERE key LIKE 'scan:pin-reservation:%' AND count<>0",
  );

describe('undo approval reservation authority', () => {
  it.each([
    ['scanner revoked', 401, 'SCANNER_REPAIR'],
    ['scanner CSRF', 401, 'SCANNER_REPAIR'],
    ['gate', 409, 'UNDO_SUPERSEDED'],
    ['org suspended', 403, 'ORG_ACCESS_CHANGED'],
  ] as const)(
    'does not spend a PIN guess when %s changes before reservation',
    async (change, status, code) => {
      const s = await scenario();
      const manager = await kit.staff('manager');
      kit.clock.advance(11 * 60_000);
      await seedBudget(s.scanner.id, manager.id);
      const before = await pinCounters();
      const undoKey = key();
      const race = raceBatch(approvalRead, (db) => {
        if (change === 'scanner revoked')
          return run(db, 'UPDATE scanners SET revoked_at=1 WHERE id=?', [s.scanner.id]);
        if (change === 'scanner CSRF')
          return run(db, 'UPDATE scanners SET csrf_secret=?,updated_at=updated_at+1 WHERE id=?', [
            'rotated-csrf',
            s.scanner.id,
          ]);
        if (change === 'org suspended')
          return run(db, "UPDATE orgs SET status='suspended' WHERE id=?", [kit.org.id]);
        return run(db, "UPDATE scan_gates SET last_scan_id='later' WHERE pass_id=?", [s.pass.id]);
      });
      await expect(
        undo(race.ctx, s.actor, s.targetId, {
          idempotencyKey: undoKey,
          approval: { staffId: manager.id, pin: '000000' },
        }),
      ).rejects.toMatchObject({ status, code });
      expect(race.raced()).toBe(true);
      expect(await pinCounters()).toEqual(before);
      if (change !== 'gate' && change !== 'org suspended') await expectNoUndo(s, undoKey);
    },
  );

  it('spends a guess when only the pass changed: pass drift is not authority', async () => {
    const s = await scenario();
    const manager = await kit.staff('manager');
    kit.clock.advance(11 * 60_000);
    await seedBudget(s.scanner.id, manager.id);
    const before = await pinCounters();
    const race = raceBatch(approvalRead, (db) =>
      run(db, 'UPDATE passes SET link_generation=link_generation+1 WHERE id=?', [s.pass.id]),
    );
    await expect(
      undo(race.ctx, s.actor, s.targetId, {
        idempotencyKey: key(),
        approval: { staffId: manager.id, pin: '000000' },
      }),
    ).rejects.toMatchObject({ status: 400, code: 'PIN_INVALID' });
    expect(race.raced()).toBe(true);
    expect(await pinCounters()).not.toEqual(before);
  });

  it('spends a wrong PIN guess when the captured authority is still current', async () => {
    const s = await scenario();
    const manager = await kit.staff('manager');
    kit.clock.advance(11 * 60_000);
    const budget = await seedBudget(s.scanner.id, manager.id);
    const undoKey = key();
    await expect(
      undo(kit.ctx, s.actor, s.targetId, {
        idempotencyKey: undoKey,
        approval: { staffId: manager.id, pin: '000000' },
      }),
    ).rejects.toMatchObject({ status: 400, code: 'PIN_INVALID' });
    expect(
      await first(kit.env.DB, 'SELECT count FROM counters WHERE key=? AND window_start=?', [
        budget.personKey,
        budget.personWindow,
      ]),
    ).toEqual({ count: 3 });
    expect(
      await first(kit.env.DB, 'SELECT count FROM counters WHERE key=? AND window_start=?', [
        budget.scannerKey,
        budget.scannerWindow,
      ]),
    ).toEqual({ count: 4 });
    await expectNoUndo(s, undoKey);
  });

  it('replays a competing successful undo with the same key without another PIN charge', async () => {
    const s = await scenario();
    const manager = await kit.staff('manager');
    kit.clock.advance(11 * 60_000);
    const budget = await seedBudget(s.scanner.id, manager.id);
    const markersBefore = await heldMarkers();
    const req = { idempotencyKey: key(), approval: { staffId: manager.id, pin: manager.pin } };
    let winnerId: string | null = null;
    const race = raceBatch(approvalRead, async () => {
      const winner = await undo(kit.ctx, s.actor, s.targetId, req);
      expect(winner.outcome).toMatchObject({ kind: 'ok', replay: false });
      if (!winner.outcome.scanId) throw new Error('Missing winning undo scan');
      winnerId = winner.outcome.scanId;
    });
    const result = await undo(race.ctx, s.actor, s.targetId, req);
    expect(race.raced()).toBe(true);
    expect(winnerId).toEqual(expect.any(String));
    expect(result.outcome).toMatchObject({ kind: 'ok', replay: true, scanId: winnerId });
    expect(
      await first(kit.env.DB, 'SELECT count FROM counters WHERE key=? AND window_start=?', [
        budget.personKey,
        budget.personWindow,
      ]),
    ).toEqual({ count: 2 });
    expect(
      await first(kit.env.DB, 'SELECT count FROM counters WHERE key=? AND window_start=?', [
        budget.scannerKey,
        budget.scannerWindow,
      ]),
    ).toEqual({ count: 3 });
    // Earlier cases in this file keep their spent-guess markers; this one adds none.
    expect(await heldMarkers()).toEqual(markersBefore);
    expect(
      await first(
        kit.env.DB,
        'SELECT count(*) AS n FROM scans WHERE actor_key=? AND idempotency_key=?',
        [s.actor.actorKey, req.idempotencyKey],
      ),
    ).toEqual({ n: 1 });
    expect(
      await first(
        kit.env.DB,
        "SELECT count(*) AS n FROM pass_events WHERE pass_id=? AND kind='scan.undone'",
        [s.pass.id],
      ),
    ).toEqual({ n: 1 });
    expect(
      await first(
        kit.env.DB,
        "SELECT count(*) AS n FROM audit_log WHERE target_id=? AND action='scan.undo'",
        [s.targetId],
      ),
    ).toEqual({ n: 1 });
  });
});
