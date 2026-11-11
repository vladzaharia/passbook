import { describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { getScanner } from './repo-device.ts';
import {
  connection,
  expectNoUndo,
  kit,
  raceBatch,
  type Scenario,
  scenario,
  templateId,
  withEpochs,
} from './repo-undo-authority-test-fixtures.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import { key } from './test-kit.ts';
import { undo } from './undo.ts';

const CHANGED_ERROR = { status: 409, code: 'SCAN_CONFIG_CHANGED' };
const CHANGED = [409, 'SCAN_CONFIG_CHANGED'] as const;
const SUPERSEDED = [409, 'UNDO_SUPERSEDED'] as const;
type Case = [string, (s: Scenario) => [string, string], readonly [number, string] | 'ok'];

describe('undo commit authority', () => {
  // Safety rows: the actor or the gate moves under the request. Liveness rows ('ok'): the pass,
  // template or policy moves, which is not authority for an undo.
  const cases: Case[] = [
    [
      'device role',
      (s: Scenario) => ["UPDATE scanners SET device_role='monitor' WHERE id=?", s.scanner.id],
      CHANGED,
    ],
    [
      'scanner revocation',
      (s: Scenario) => ['UPDATE scanners SET revoked_at=1 WHERE id=?', s.scanner.id],
      [401, 'SCANNER_REPAIR'],
    ],
    [
      'organization suspension',
      () => ["UPDATE orgs SET status='suspended' WHERE id=?", kit.org.id],
      [403, 'ORG_ACCESS_CHANGED'],
    ],
    [
      'pass quarantine',
      (s: Scenario) => ['UPDATE passes SET test_data_quarantined=1 WHERE id=?', s.pass.id],
      [409, 'SCAN_RETAINED'],
    ],
    [
      'gate generation',
      (s: Scenario) => ['UPDATE scan_gates SET count=count+1 WHERE pass_id=?', s.pass.id],
      SUPERSEDED,
    ],
    [
      'gate restoration state',
      (s: Scenario) => ["UPDATE scan_gates SET prev_state='out' WHERE pass_id=?", s.pass.id],
      SUPERSEDED,
    ],
    [
      'target timestamp',
      (s: Scenario) => ['UPDATE scans SET at=at+1 WHERE id=?', s.targetId],
      SUPERSEDED,
    ],
    [
      'target state',
      (s: Scenario) => ["UPDATE scans SET state='failed' WHERE id=?", s.targetId],
      SUPERSEDED,
    ],
    [
      'target operator',
      (s: Scenario) => ["UPDATE scans SET actor_key='s:other' WHERE id=?", s.targetId],
      SUPERSEDED,
    ],
    // Liveness: pass, template and policy changes are not authority for an undo.
    [
      'pass void',
      (s: Scenario) => ["UPDATE passes SET status='voided' WHERE id=?", s.pass.id],
      'ok',
    ],
    [
      'pass removal',
      (s: Scenario) => ['UPDATE passes SET removed_at=1 WHERE id=?', s.pass.id],
      'ok',
    ],
    [
      'pass deletion',
      (s: Scenario) => ['UPDATE passes SET deleted_at=1 WHERE id=?', s.pass.id],
      'ok',
    ],
    [
      'template deletion',
      () => ["UPDATE templates SET status='deleted' WHERE id=?", templateId],
      'ok',
    ],
    [
      'pass revision',
      (s: Scenario) => ['UPDATE passes SET revision=revision+1 WHERE id=?', s.pass.id],
      'ok',
    ],
    [
      'pass link generation',
      (s: Scenario) => [
        'UPDATE passes SET link_generation=link_generation+1 WHERE id=?',
        s.pass.id,
      ],
      'ok',
    ],
    [
      'pass image generation',
      (s: Scenario) => [
        'UPDATE passes SET image_generation=image_generation+1 WHERE id=?',
        s.pass.id,
      ],
      'ok',
    ],
  ];
  it.each(cases)('%s while the undo commits', async (_label, change, expected) => {
    const s = await scenario();
    const undoKey = key();
    const race = raceBatch('UPDATE scan_gates SET state', async (db) => {
      const [sql, id] = change(s);
      if (!sql || !id) throw new Error('Missing race mutation');
      await run(db, sql, [id]);
    });
    const result = undo(race.ctx, s.actor, s.targetId, { idempotencyKey: undoKey });
    if (expected === 'ok') {
      expect((await result).outcome).toMatchObject({ kind: 'ok', replay: false });
      expect(race.raced()).toBe(true);
      return;
    }
    await expect(result).rejects.toMatchObject({ status: expected[0], code: expected[1] });
    expect(race.raced()).toBe(true);
    await expectNoUndo(s, undoKey);
  });

  it('rejects an unreserved pass mode change before an undo', async () => {
    const s = await scenario();
    await expect(
      run(kit.env.DB, "UPDATE passes SET mode='test' WHERE id=?", [s.pass.id]),
    ).rejects.toThrow('credential transfer required');
    expect(await first(kit.env.DB, 'SELECT mode FROM passes WHERE id=?', [s.pass.id])).toEqual({
      mode: 'live',
    });
    expect(
      (await undo(kit.ctx, s.actor, s.targetId, { idempotencyKey: key() })).outcome,
    ).toMatchObject({ kind: 'ok' });
  });

  it('does not restore a presence superseded after the gate snapshot', async () => {
    const s = await scenario();
    const undoKey = key();
    const newer = kit.fx.ids.ordered();
    const race = raceBatch('UPDATE scan_gates SET state', (db) =>
      run(db, 'UPDATE scan_presence SET last_scan_id=? WHERE pass_id=?', [newer, s.pass.id]),
    );
    await expect(
      undo(race.ctx, s.actor, s.targetId, { idempotencyKey: undoKey }),
    ).rejects.toMatchObject({ status: 409, code: 'UNDO_SUPERSEDED' });
    expect(race.raced()).toBe(true);
    expect(await first(kit.env.DB, 'SELECT undone_by FROM scans WHERE id=?', [s.targetId])).toEqual(
      { undone_by: null },
    );
    expect(
      await first(kit.env.DB, 'SELECT last_scan_id FROM scan_presence WHERE pass_id=?', [
        s.pass.id,
      ]),
    ).toEqual({ last_scan_id: newer });
    expect(
      await first(kit.env.DB, 'SELECT id FROM scans WHERE actor_key=? AND idempotency_key=?', [
        s.actor.actorKey,
        undoKey,
      ]),
    ).toBeNull();
    expect(
      await first(kit.env.DB, "SELECT id FROM pass_events WHERE pass_id=? AND kind='scan.undone'", [
        s.pass.id,
      ]),
    ).toBeNull();
    expect(
      await first(kit.env.DB, "SELECT id FROM audit_log WHERE target_id=? AND action='scan.undo'", [
        s.targetId,
      ]),
    ).toBeNull();
  });

  it.each(['disabled', 'role', 'unbound'] as const)(
    'refuses the signed-in operator when %s changes',
    async (change) => {
      const staff = await kit.staff('desk');
      const s = await scenario(undefined, staff.id);
      const undoKey = key();
      const race = raceBatch('UPDATE scan_gates SET state', (db) =>
        change === 'unbound'
          ? run(db, 'UPDATE scanners SET staff_id=NULL WHERE id=?', [s.scanner.id])
          : run(
              db,
              change === 'disabled'
                ? 'UPDATE scan_staff SET disabled_at=1 WHERE id=?'
                : "UPDATE scan_staff SET role='door' WHERE id=?",
              [staff.id],
            ),
      );
      await expect(
        undo(race.ctx, s.actor, s.targetId, { idempotencyKey: undoKey }),
      ).rejects.toMatchObject({ status: 409, code: 'SCAN_STAFF_CHANGED' });
      expect(race.raced()).toBe(true);
      await expectNoUndo(s, undoKey);
    },
  );

  it('undoes when the signed-in operator row only changes its timestamp', async () => {
    const staff = await kit.staff('desk');
    const s = await scenario(undefined, staff.id);
    const race = raceBatch('UPDATE scan_gates SET state', (db) =>
      run(db, 'UPDATE scan_staff SET updated_at=updated_at+1 WHERE id=?', [staff.id]),
    );
    expect(
      (await undo(race.ctx, s.actor, s.targetId, { idempotencyKey: key() })).outcome,
    ).toMatchObject({ kind: 'ok', replay: false });
    expect(race.raced()).toBe(true);
  });

  it('refuses a paused scanning session', async () => {
    const s = await scenario();
    const sessionId = kit.fx.ids.id();
    await run(
      kit.env.DB,
      `INSERT INTO scanning_sessions
      (id,org_id,mode,name,status,accepts,settings,time_zone,created_at,updated_at)
      SELECT ?,org_id,mode,name,'active',?,settings,time_zone,created_at,updated_at
      FROM scanners WHERE id=?`,
      [sessionId, JSON.stringify({ templateIds: [templateId] }), s.scanner.id],
    );
    await run(
      kit.env.DB,
      `INSERT INTO scanning_devices
      (scanner_id,session_id,org_id,mode,surface,effective_surface,overrides)
      SELECT id,?,org_id,mode,'phone','phone','{}' FROM scanners WHERE id=?`,
      [sessionId, s.scanner.id],
    );
    await bindScanningSession(kit.ctx, s.actor);
    const row = await getScanner(kit.env.DB, s.scanner.id);
    if (!row) throw new Error('Missing scanner');
    await withEpochs(row, s.actor);
    const undoKey = key();
    const race = raceBatch('UPDATE scan_gates SET state', (db) =>
      run(db, "UPDATE scanning_sessions SET status='paused' WHERE id=?", [sessionId]),
    );
    await expect(
      undo(race.ctx, s.actor, s.targetId, { idempotencyKey: undoKey }),
    ).rejects.toMatchObject(CHANGED_ERROR);
    expect(race.raced()).toBe(true);
    await expectNoUndo(s, undoKey);
  });

  it('undoes when an admission policy row appears', async () => {
    const s = await scenario();
    const race = raceBatch('UPDATE scan_gates SET state', (db) =>
      run(
        db,
        'INSERT INTO pass_check_in(pass_id,org_id,rules,updated_at) VALUES (?,?,\'{"mode":"single"}\',?)',
        [s.pass.id, kit.org.id, kit.clock.now()],
      ),
    );
    expect(
      (await undo(race.ctx, s.actor, s.targetId, { idempotencyKey: key() })).outcome.kind,
    ).toBe('ok');
    expect(race.raced()).toBe(true);
  });

  it('refuses when a held presence field changes in place', async () => {
    const s = await scenario();
    const undoKey = key();
    const race = raceBatch('UPDATE scan_gates SET state', (db) =>
      run(db, 'UPDATE scan_presence SET tracking=1-tracking WHERE pass_id=?', [s.pass.id]),
    );
    await expect(
      undo(race.ctx, s.actor, s.targetId, { idempotencyKey: undoKey }),
    ).rejects.toMatchObject({ status: 409, code: 'UNDO_SUPERSEDED' });
    expect(race.raced()).toBe(true);
    await expectNoUndo(s, undoKey);
  });

  it('undoes when the linked connection changes generation', async () => {
    const connectionId = await connection();
    const s = await scenario(undefined, undefined, connectionId);
    const race = raceBatch('UPDATE scan_gates SET state', (db) =>
      run(db, 'UPDATE connections SET generation=generation+1 WHERE id=?', [connectionId]),
    );
    expect(
      (await undo(race.ctx, s.actor, s.targetId, { idempotencyKey: key() })).outcome.kind,
    ).toBe('ok');
    expect(race.raced()).toBe(true);
  });

  it.each(['event', 'template'] as const)('refuses a changed %s event scope', async (change) => {
    const event = await kit.event({ templateIds: [templateId] });
    const s = await scenario(event.id);
    const undoKey = key();
    const race = raceBatch('UPDATE scan_gates SET state', (db) =>
      change === 'event'
        ? run(db, 'UPDATE scan_events SET archived_at=1 WHERE id=?', [event.id])
        : run(db, 'DELETE FROM scan_event_templates WHERE event_id=? AND template_id=?', [
            event.id,
            templateId,
          ]),
    );
    await expect(
      undo(race.ctx, s.actor, s.targetId, { idempotencyKey: undoKey }),
    ).rejects.toMatchObject(CHANGED_ERROR);
    expect(race.raced()).toBe(true);
    await expectNoUndo(s, undoKey);
  });
});
