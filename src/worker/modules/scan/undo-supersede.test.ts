import { describe, expect, it } from 'vitest';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { all, first, run } from '../../platform/db.ts';
import {
  expectNoUndo,
  kit,
  rollReleaseAwayAndBack,
  scenario,
} from './repo-undo-authority-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';
import { undo } from './undo.ts';

const status = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (e: { status: number; code: string }) => `${e.status} ${e.code}`,
  );

describe('undo safety', () => {
  it('refuses with UNDO_SUPERSEDED when a later scan took the gate', async () => {
    const s = await scenario();
    const exit = await kit.post(s.scanner.headers, '/actions', {
      idempotencyKey: key(),
      input: codeOf(s.pass),
      clientTs: kit.clock.now(),
      actionId: 'enter',
    });
    const out = (await exit.json()) as ScanOutcome;
    expect(out).toMatchObject({ kind: 'ok', checkIn: { direction: 'out' } });
    const undoKey = key();
    expect(await status(undo(kit.ctx, s.actor, s.targetId, { idempotencyKey: undoKey }))).toBe(
      '409 UNDO_SUPERSEDED',
    );
    expect(await first(kit.env.DB, 'SELECT undone_by FROM scans WHERE id=?', [s.targetId])).toEqual(
      { undone_by: null },
    );
    expect(
      await first(kit.env.DB, 'SELECT last_scan_id FROM scan_gates WHERE pass_id=?', [s.pass.id]),
    ).toEqual({ last_scan_id: out.scanId });
    expect(
      await first(kit.env.DB, 'SELECT id FROM scans WHERE idempotency_key=?', [undoKey]),
    ).toBeNull();
  });

  it('refuses a scan that another key already undid', async () => {
    const s = await scenario();
    await undo(kit.ctx, s.actor, s.targetId, { idempotencyKey: key() });
    expect(await status(undo(kit.ctx, s.actor, s.targetId, { idempotencyKey: key() }))).toBe(
      '409 UNDO_SUPERSEDED',
    );
  });

  it('refuses a key reused for another scan', async () => {
    const s = await scenario();
    const reused = key();
    await undo(kit.ctx, s.actor, s.targetId, { idempotencyKey: reused });
    expect(await status(undo(kit.ctx, s.actor, kit.fx.ids.id(), { idempotencyKey: reused }))).toBe(
      '422 IDEMPOTENCY_KEY_REUSED',
    );
  });

  it.each([
    ['a revoked scanner', 'UPDATE scanners SET revoked_at=1 WHERE id=?', '401 SCANNER_REPAIR'],
    [
      'a rotated credential',
      "UPDATE scanners SET token_hash='rotated',updated_at=updated_at+1 WHERE id=?",
      '401 SCANNER_REPAIR',
    ],
  ] as const)('refuses %s', async (_label, sql, expected) => {
    const s = await scenario();
    await run(kit.env.DB, sql, [s.scanner.id]);
    const undoKey = key();
    expect(await status(undo(kit.ctx, s.actor, s.targetId, { idempotencyKey: undoKey }))).toBe(
      expected,
    );
    await expectNoUndo(s, undoKey);
  });

  it('refuses a suspended organization', async () => {
    const s = await scenario();
    await run(kit.env.DB, "UPDATE orgs SET status='suspended' WHERE id=?", [kit.org.id]);
    expect(await status(undo(kit.ctx, s.actor, s.targetId, { idempotencyKey: key() }))).toBe(
      '403 ORG_ACCESS_CHANGED',
    );
  });

  it.each(['the pass is quarantined', 'only its exclusion row exists'] as const)(
    'cannot undo a quarantined scan: %s',
    async (how) => {
      const s = await scenario();
      if (how === 'the pass is quarantined')
        await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined=1 WHERE id=?', [s.pass.id]);
      else
        await run(
          kit.env.DB,
          'INSERT OR IGNORE INTO scan_quarantine_exclusions (scan_id) VALUES (?)',
          [s.targetId],
        );
      const undoKey = key();
      expect(await status(undo(kit.ctx, s.actor, s.targetId, { idempotencyKey: undoKey }))).toBe(
        '409 SCAN_RETAINED',
      );
      await expectNoUndo(s, undoKey);
    },
  );

  it('does not find an unknown scan, or a live scan from a test-mode scanner', async () => {
    const s = await scenario();
    const testScanner = await scenario(undefined, undefined, undefined, 'test');
    expect(await status(undo(kit.ctx, s.actor, kit.fx.ids.id(), { idempotencyKey: key() }))).toBe(
      '404 SCAN_NOT_FOUND',
    );
    expect(
      await status(undo(kit.ctx, testScanner.actor, s.targetId, { idempotencyKey: key() })),
    ).toBe('404 SCAN_NOT_FOUND');
  });

  it('refuses a scan outside the scanner template scope', async () => {
    const s = await scenario();
    const other = await kit.scanTemplate('Other', {
      actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }],
    });
    s.actor.templateIds = [other];
    expect(await status(undo(kit.ctx, s.actor, s.targetId, { idempotencyKey: key() }))).toBe(
      '404 SCAN_NOT_FOUND',
    );
  });
});

describe('undo liveness', () => {
  it('works after a settings save, a branding edit and an org rename', async () => {
    const s = await scenario();
    await run(
      kit.env.DB,
      "INSERT INTO settings (scope,key,value,updated_at) VALUES (?, 'scan.letInAgain','true',?)",
      [`org:${kit.org.id}`, kit.clock.now()],
    );
    await run(
      kit.env.DB,
      'UPDATE orgs SET name=\'Renamed\',branding=\'{"accent":"#fff"}\' WHERE id=?',
      [kit.org.id],
    );
    expect(
      (await undo(kit.ctx, s.actor, s.targetId, { idempotencyKey: key() })).outcome,
    ).toMatchObject({ kind: 'ok', replay: false });
  });

  it('works after a publish, a release approval and a head change', async () => {
    const s = await scenario();
    await run(
      kit.env.DB,
      "UPDATE passes SET version=version+1,revision=revision+1,personalization=json_set(personalization,'$.memberName','Edited') WHERE id=?",
      [s.pass.id],
    );
    await rollReleaseAwayAndBack(kit.env.DB);
    expect(
      (await undo(kit.ctx, s.actor, s.targetId, { idempotencyKey: key() })).outcome,
    ).toMatchObject({ kind: 'ok', replay: false });
  });

  it('works for a scan from before this branch: old proofs, a pre-cutover revision, no ledger row', async () => {
    const s = await scenario();
    const old = 1_700_000_000_000;
    await run(
      kit.env.DB,
      `UPDATE pass_events SET data=json_set(json_remove(data,'$.authority.eventProof'),
        '$.authority.orgRevision',?,'$.authority.membershipOrgRevision',?)
       WHERE pass_id=? AND kind='scan.checked_in'`,
      [old, old, s.pass.id],
    );
    const result = await undo(kit.ctx, s.actor, s.targetId, { idempotencyKey: key() });
    expect(result.outcome).toMatchObject({ kind: 'ok', replay: false });
    const bare = await scenario();
    await run(kit.env.DB, "DELETE FROM pass_events WHERE pass_id=? AND kind='scan.checked_in'", [
      bare.pass.id,
    ]);
    expect(
      (await undo(kit.ctx, bare.actor, bare.targetId, { idempotencyKey: key() })).outcome,
    ).toMatchObject({ kind: 'ok', replay: false });
  });

  it('retries after commit with the same key and returns the committed undo', async () => {
    const s = await scenario();
    const req = { idempotencyKey: key() };
    const first1 = await undo(kit.ctx, s.actor, s.targetId, req);
    kit.clock.advance(60_000);
    const again = await undo(kit.ctx, s.actor, s.targetId, req);
    expect(again.outcome).toMatchObject({
      kind: 'ok',
      replay: true,
      scanId: first1.outcome.scanId,
    });
    expect(
      await all(kit.env.DB, 'SELECT id FROM scans WHERE idempotency_key=?', [req.idempotencyKey]),
    ).toHaveLength(1);
  });

  it('answers two concurrent requests with one key by committing once', async () => {
    const s = await scenario();
    const req = { idempotencyKey: key() };
    const [a, b] = await Promise.all([
      undo(kit.ctx, s.actor, s.targetId, req),
      undo(kit.ctx, s.actor, s.targetId, req),
    ]);
    expect([a.outcome.kind, b.outcome.kind]).toEqual(['ok', 'ok']);
    expect([a.outcome.replay, b.outcome.replay].sort()).toEqual([false, true]);
    expect(a.outcome.scanId).toBe(b.outcome.scanId);
    expect(
      await first(
        kit.env.DB,
        "SELECT count(*) AS n FROM pass_events WHERE pass_id=? AND kind='scan.undone'",
        [s.pass.id],
      ),
    ).toEqual({ n: 1 });
  });
});
