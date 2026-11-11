import { beforeAll, describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import {
  action,
  atGate,
  beforeEffectRead,
  type CapturedState,
  expectStaleWithoutEffects,
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

describe('signed gate and presence preflight', () => {
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

  it('signs exact observed rows for first entry, check-out and returning entry', async () => {
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

  it('signs unchanged absent presence for untracked first and repeat actions', async () => {
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

  it('does not commit a stale action when a real competing action wins the gate', async () => {
    const s = await scenario();
    const requestKey = key();
    let winningState: CapturedState | undefined;
    const outcome = await atGate(
      async () => {
        expect(await action(s)).toMatchObject({ kind: 'ok', checkIn: { direction: 'in' } });
        winningState = await state(s.pass);
      },
      () => action(s, requestKey),
    );
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'not_found' });
    if (!winningState) throw new Error('Missing interleaved state');
    await expectStaleWithoutEffects(s, requestKey, winningState);
  });

  it('quarantines an ambiguous competing reference and never reopens its claim', async () => {
    const s = await scenario();
    const requestKey = key();
    let changed: CapturedState | undefined;
    const outcome = await atGate(
      async (db) => {
        const claim = await first<{ id: string }>(
          db,
          'SELECT id FROM scans WHERE idempotency_key=?',
          [requestKey],
        );
        if (!claim) throw new Error('Missing pending claim');
        await run(
          db,
          `INSERT INTO scan_gates(pass_id,action_id,scope,org_id,mode,template_id,kind,state,count,first_at,last_at,last_scan_id)
        VALUES (?,?,?,?,'live',?,'check_in','in',1,?,?,?)`,
          [
            s.pass.id,
            s.gate.actionId,
            '',
            kit.org.id,
            templateId,
            kit.clock.now(),
            kit.clock.now(),
            claim.id,
          ],
        );
        changed = await state(s.pass);
      },
      () => action(s, requestKey),
    );
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'not_found' });
    if (!changed) throw new Error('Missing interleaved state');
    expect(await state(s.pass)).toEqual(changed);
    expect(
      await first(kit.env.DB, 'SELECT state,reason FROM scans WHERE idempotency_key=?', [
        requestKey,
      ]),
    ).toEqual({ state: 'failed', reason: 'stale' });
    expect(await action(s, requestKey)).toMatchObject({ kind: 'refused', reason: 'not_found' });
    expect(await state(s.pass)).toEqual(changed);
  });

  it.each(['gate', 'presence'] as const)(
    'refuses when an absent %s appears before the gate batch',
    async (kind) => {
      const s = await scenario();
      const requestKey = key();
      let changed: CapturedState | undefined;
      const outcome = await atGate(
        async (db) => {
          if (kind === 'gate') {
            await run(
              db,
              `INSERT INTO scan_gates(pass_id,action_id,scope,org_id,mode,template_id,kind,state,count,first_at,last_at,last_scan_id)
          VALUES (?,?,?,?,'live',?,'check_in','in',1,?,?,?)`,
              [
                s.pass.id,
                s.gate.actionId,
                '',
                kit.org.id,
                templateId,
                kit.clock.now(),
                kit.clock.now(),
                'racing-gate',
              ],
            );
          } else {
            await run(
              db,
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
          }
          changed = await state(s.pass);
        },
        () => action(s, requestKey),
      );
      expect(outcome).toMatchObject({ kind: 'refused', reason: 'not_found' });
      if (!changed) throw new Error('Missing interleaved state');
      await expectStaleWithoutEffects(s, requestKey, changed);
    },
  );

  it.each([
    ['gate count', 'UPDATE scan_gates SET count=count+1 WHERE pass_id=?'],
    ['gate state', "UPDATE scan_gates SET state='out' WHERE pass_id=?"],
    ['gate template', "UPDATE scan_gates SET template_id='changed' WHERE pass_id=?"],
    ['gate first time', 'UPDATE scan_gates SET first_at=first_at+1 WHERE pass_id=?'],
    ['gate last time', 'UPDATE scan_gates SET last_at=last_at+1 WHERE pass_id=?'],
    ['gate previous state', "UPDATE scan_gates SET prev_state='out' WHERE pass_id=?"],
    ['gate previous time', 'UPDATE scan_gates SET prev_last_at=1 WHERE pass_id=?'],
    ['gate previous scan', "UPDATE scan_gates SET prev_scan_id='changed' WHERE pass_id=?"],
    [
      'gate holder state',
      "UPDATE scans SET state='failed' WHERE id=(SELECT last_scan_id FROM scan_gates WHERE pass_id=?)",
    ],
    [
      'gate holder undo',
      "UPDATE scans SET undone_by='changed' WHERE id=(SELECT last_scan_id FROM scan_gates WHERE pass_id=?)",
    ],
    ['presence state', "UPDATE scan_presence SET state='out' WHERE pass_id=?"],
    ['presence tracking', 'UPDATE scan_presence SET tracking=0 WHERE pass_id=?'],
    ['presence entry time', 'UPDATE scan_presence SET entered_at=entered_at+1 WHERE pass_id=?'],
    ['presence first time', 'UPDATE scan_presence SET first_at=first_at+1 WHERE pass_id=?'],
    [
      'presence last entry',
      'UPDATE scan_presence SET last_entry_at=last_entry_at+1 WHERE pass_id=?',
    ],
    ['presence previous state', "UPDATE scan_presence SET prev_state='out' WHERE pass_id=?"],
    ['presence previous tracking', 'UPDATE scan_presence SET prev_tracking=0 WHERE pass_id=?'],
    ['presence previous entry', 'UPDATE scan_presence SET prev_entered_at=1 WHERE pass_id=?'],
    ['presence previous first', 'UPDATE scan_presence SET prev_first_at=1 WHERE pass_id=?'],
    ['presence previous last', 'UPDATE scan_presence SET prev_last_entry_at=1 WHERE pass_id=?'],
    ['presence previous scan', "UPDATE scan_presence SET prev_scan_id='changed' WHERE pass_id=?"],
  ])('refuses a %s change even when last_scan_id is unchanged', async (_label, sql) => {
    const s = await scenario();
    expect(await action(s)).toMatchObject({ kind: 'ok' });
    const requestKey = key();
    let changed: CapturedState | undefined;
    const outcome = await atGate(
      async (db) => {
        await run(db, sql, [s.pass.id]);
        changed = await state(s.pass);
      },
      () => action(s, requestKey),
    );
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'not_found' });
    if (!changed) throw new Error('Missing interleaved state');
    await expectStaleWithoutEffects(s, requestKey, changed);
  });

  it.each(['scan_gates', 'scan_presence'] as const)(
    'refuses when an observed %s row disappears',
    async (table) => {
      const s = await scenario();
      expect(await action(s)).toMatchObject({ kind: 'ok' });
      const requestKey = key();
      let changed: CapturedState | undefined;
      const outcome = await atGate(
        async (db) => {
          await run(db, `DELETE FROM ${table} WHERE pass_id=?`, [s.pass.id]);
          changed = await state(s.pass);
        },
        () => action(s, requestKey),
      );
      expect(outcome).toMatchObject({ kind: 'refused', reason: 'not_found' });
      if (!changed) throw new Error('Missing interleaved state');
      await expectStaleWithoutEffects(s, requestKey, changed);
    },
  );

  it('refuses presence changed after admission planning but before effect preflight', async () => {
    const s = await scenario();
    expect(await action(s)).toMatchObject({ kind: 'ok' });
    const requestKey = key();
    let changed: CapturedState | undefined;
    const outcome = await beforeEffectRead(
      async (db) => {
        await run(db, 'UPDATE scan_presence SET entered_at=entered_at+1 WHERE pass_id=?', [
          s.pass.id,
        ]);
        changed = await state(s.pass);
      },
      () => action(s, requestKey),
    );
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'not_found' });
    if (!changed) throw new Error('Missing interleaved state');
    await expectStaleWithoutEffects(s, requestKey, changed);
  });
});
