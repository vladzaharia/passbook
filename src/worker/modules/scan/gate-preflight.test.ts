import { beforeAll, describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import {
  action,
  atGate,
  type CapturedState,
  kit,
  scenario,
  setupGatePreflight,
  signedEffect,
  state,
  templateId,
} from './repo-gate-preflight-test-fixtures.ts';
import { readScanEffect, readScanEffectStmt, scanEffectFromResult } from './repo-scan-effect.ts';
import { key } from './test-kit.ts';

beforeAll(setupGatePreflight);

const gateRow = (passId: string, actionId: string, lastScanId: string) =>
  run(
    kit.env.DB,
    `INSERT INTO scan_gates(pass_id,action_id,scope,org_id,mode,template_id,kind,state,count,first_at,last_at,last_scan_id)
     VALUES (?,?,?,?,'live',?,'check_in','in',1,?,?,?)`,
    [passId, actionId, '', kit.org.id, templateId, kit.clock.now(), kit.clock.now(), lastScanId],
  );

/**
 * The gate is the serialization point: the grant batch writes it first-wins (or takes it over by
 * the action's rule) and finalizes `ok` only when it names this scan. A scan that loses records a
 * truthful heads-up in the same batch. Gate and presence columns are not compared (no column fence).
 */
describe('gate and presence preflight', () => {
  it('decodes the same absent and present snapshots from a batched preflight', async () => {
    const s = await scenario();
    const readBatched = async () => {
      const results = await kit.env.DB.batch([readScanEffectStmt(kit.env.DB, s.gate, '')]);
      return scanEffectFromResult(results[0]);
    };
    expect(await readBatched()).toEqual({ gateBefore: null, presenceBefore: null });
    expect(await action(s)).toMatchObject({ kind: 'ok' });
    const present = await readBatched();
    expect(present.gateBefore).not.toBeNull();
    expect(present.presenceBefore).not.toBeNull();
    expect(present).toEqual(await readScanEffect(kit.env.DB, s.gate, ''));
    expect(() => scanEffectFromResult(undefined)).toThrow('Missing scan effect snapshot');
  });

  it('records exact observed rows for first entry, check-out and returning entry', async () => {
    const s = await scenario();
    for (const direction of ['in', 'out', 'in'] as const) {
      kit.clock.advance(1_000);
      const before = await readScanEffect(kit.env.DB, s.gate, '');
      const outcome = await action(s);
      expect(outcome).toMatchObject({ kind: 'ok', checkIn: { direction } });
      if (!outcome.scanId) throw new Error('Missing scan id');
      const after = await readScanEffect(kit.env.DB, s.gate, '');
      await signedEffect(s, outcome.scanId, {
        gateBefore: before.gateBefore,
        gateAfter: after.gateBefore,
        presenceBefore: before.presenceBefore,
        presenceAfter: after.presenceBefore,
      });
    }
  });

  it('records unchanged absent presence for untracked first and repeat actions', async () => {
    const base = await scenario();
    const s = { ...base, scanner: await kit.scanner({ templateIds: [templateId] }) };
    for (let i = 0; i < 2; i++) {
      const before = await readScanEffect(kit.env.DB, s.gate, '');
      const outcome = await action(s);
      expect(outcome).toMatchObject({ kind: 'ok' });
      if (!outcome.scanId) throw new Error('Missing scan id');
      const after = await readScanEffect(kit.env.DB, s.gate, '');
      await signedEffect(s, outcome.scanId, {
        gateBefore: before.gateBefore,
        gateAfter: after.gateBefore,
        presenceBefore: null,
        presenceAfter: null,
      });
    }
  });

  it('answers a heads-up naming the winner when a real competing action wins the gate', async () => {
    const s = await scenario();
    const requestKey = key();
    let winner: { scanId: string | null } | undefined;
    let winningState: CapturedState | undefined;
    const outcome = await atGate(
      async () => {
        winner = await action(s);
        expect(winner).toMatchObject({ kind: 'ok', checkIn: { direction: 'in' } });
        winningState = await state(s.pass);
      },
      () => action(s, requestKey),
    );
    if (!winner?.scanId || !winningState) throw new Error('Missing interleaved winner');
    // The winner admitted the pass: the loser hears what a fresh read says, still inside.
    expect(outcome).toMatchObject({
      kind: 'heads_up',
      reason: 'still_inside',
      overridable: false,
      previous: { scanId: winner.scanId },
    });
    // The loser moved neither the gate nor presence; its heads-up is recorded once.
    const after = await state(s.pass);
    expect({ gate: after.gate, presence: after.presence }).toEqual({
      gate: winningState.gate,
      presence: winningState.presence,
    });
    expect(
      await first(kit.env.DB, 'SELECT state,outcome,reason FROM scans WHERE idempotency_key=?', [
        requestKey,
      ]),
    ).toEqual({ state: 'done', outcome: 'heads_up', reason: 'still_inside' });
    expect(after.events).toHaveLength(winningState.events.length + 1);
  });

  it('finishes once when the gate already names this pending scan', async () => {
    const s = await scenario();
    const requestKey = key();
    const outcome = await atGate(
      async () => {
        const claim = await first<{ id: string }>(
          kit.env.DB,
          'SELECT id FROM scans WHERE idempotency_key=?',
          [requestKey],
        );
        if (!claim) throw new Error('Missing pending claim');
        await gateRow(s.pass.id, s.gate.actionId, claim.id);
      },
      () => action(s, requestKey),
    );
    expect(outcome).toMatchObject({ kind: 'ok' });
    const finished = await state(s.pass);
    expect(finished.gate).toMatchObject([{ count: 1, last_scan_id: outcome.scanId }]);
    // The same key replays the receipt; nothing is written twice.
    expect(await action(s, requestKey)).toMatchObject({ scanId: outcome.scanId, replay: true });
    expect(await state(s.pass)).toEqual(finished);
  });

  it('records a heads-up when an absent gate appears before the gate batch', async () => {
    const s = await scenario();
    const requestKey = key();
    const outcome = await atGate(
      async () => {
        await gateRow(s.pass.id, s.gate.actionId, 'racing-gate');
      },
      () => action(s, requestKey),
    );
    expect(outcome).toMatchObject({ kind: 'heads_up', reason: 'in_progress' });
    const after = await state(s.pass);
    expect(after.gate).toMatchObject([{ count: 1, last_scan_id: 'racing-gate' }]);
    expect(after.presence).toEqual([]);
  });

  it('never overwrites a presence row it did not observe', async () => {
    const s = await scenario();
    const outcome = await atGate(
      async () => {
        await run(
          kit.env.DB,
          `INSERT INTO scan_presence(pass_id,org_id,scope,state,tracking,entered_at,first_at,last_entry_at,last_scan_id)
           VALUES (?,?,'','in',1,?,?,?,?)`,
          [
            s.pass.id,
            kit.org.id,
            kit.clock.now(),
            kit.clock.now(),
            kit.clock.now(),
            'racing-presence',
          ],
        );
      },
      () => action(s),
    );
    // Admission repeats the presence it read: the pass went in meanwhile, so the scan admits
    // nothing, takes no gate and keeps the unobserved presence row.
    expect(outcome).toMatchObject({ kind: 'heads_up', reason: 'still_inside', overridable: false });
    const after = await state(s.pass);
    expect(after.gate).toEqual([]);
    expect(after.presence).toMatchObject([{ last_scan_id: 'racing-presence' }]);
  });

  // Volatile gate and presence columns are not authority: with the holder unchanged the visit is
  // admitted and takes the gate (repeat: always).
  it.each([
    ['gate count', 'UPDATE scan_gates SET count=count+1 WHERE pass_id=?'],
    ['gate last time', 'UPDATE scan_gates SET last_at=last_at+1 WHERE pass_id=?'],
    ['presence entry time', 'UPDATE scan_presence SET entered_at=entered_at+1 WHERE pass_id=?'],
  ])('admits the visit when the %s changes and the holder does not', async (_label, sql) => {
    const s = await scenario();
    expect(await action(s)).toMatchObject({ kind: 'ok', checkIn: { direction: 'in' } });
    const outcome = await atGate(
      async () => {
        await run(kit.env.DB, sql, [s.pass.id]);
      },
      () => action(s),
    );
    expect(outcome).toMatchObject({ kind: 'ok', checkIn: { direction: 'out' } });
    const after = await state(s.pass);
    expect(after.gate).toMatchObject([{ state: 'out', last_scan_id: outcome.scanId }]);
    expect(after.presence).toMatchObject([{ state: 'out', last_scan_id: outcome.scanId }]);
  });
});
