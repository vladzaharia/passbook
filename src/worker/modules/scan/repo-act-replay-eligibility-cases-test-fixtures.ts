import { expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import {
  act,
  CHECK_IN,
  expectOriginalLedger,
  expectReceipt,
  expectRedactedReceipt,
  expectUnavailable,
  HOUR,
  kit,
  MINUTE,
  out,
  rows,
  tpl,
} from './act-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

export function registerReplayEligibility() {
  it('redacts ineligible pass data while retaining a proven receipt, except for quarantine', async () => {
    const changes: { name: string; apply: (id: string) => Promise<unknown> }[] = [
      {
        name: 'quarantined',
        apply: (id) =>
          run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [id]),
      },
      {
        name: 'soft deleted',
        apply: (id) => run(kit.env.DB, 'UPDATE passes SET deleted_at = 1 WHERE id = ?', [id]),
      },
      {
        name: 'removed',
        apply: (id) => run(kit.env.DB, 'UPDATE passes SET removed_at = 1 WHERE id = ?', [id]),
      },
      {
        name: 'voided',
        apply: (id) => run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [id]),
      },
      {
        name: 'wallet voided',
        apply: (id) =>
          run(
            kit.env.DB,
            "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.voided', json('true')) WHERE pass_id = ?",
            [id],
          ),
      },
      {
        name: 'expired',
        apply: (id) =>
          run(
            kit.env.DB,
            "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.expirationDate', '2020-01-01T00:00:00Z') WHERE pass_id = ?",
            [id],
          ),
      },
      {
        name: 'invalid expiry',
        apply: (id) =>
          run(
            kit.env.DB,
            "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.expirationDate', 'invalid') WHERE pass_id = ?",
            [id],
          ),
      },
      {
        name: 'invalid void flag',
        apply: (id) =>
          run(
            kit.env.DB,
            "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.voided', 'yes') WHERE pass_id = ?",
            [id],
          ),
      },
      {
        name: 'mismatched serial',
        apply: (id) =>
          run(
            kit.env.DB,
            "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.serialNumber', 'WRONG') WHERE pass_id = ?",
            [id],
          ),
      },
      {
        name: 'incomplete snapshot',
        apply: (id) =>
          run(kit.env.DB, 'UPDATE pass_versions SET pass_json = ? WHERE pass_id = ?', ['{}', id]),
      },
      {
        name: 'array snapshot',
        apply: (id) =>
          run(kit.env.DB, 'UPDATE pass_versions SET pass_json = ? WHERE pass_id = ?', ['[]', id]),
      },
      {
        name: 'invalid snapshot',
        apply: (id) =>
          run(kit.env.DB, 'UPDATE pass_versions SET pass_json = ? WHERE pass_id = ?', [
            '{invalid',
            id,
          ]),
      },
      {
        name: 'missing snapshot',
        apply: (id) =>
          run(kit.env.DB, 'UPDATE pass_versions SET pass_json = NULL WHERE pass_id = ?', [id]),
      },
      {
        name: 'hard deleted',
        apply: (id) => run(kit.env.DB, 'DELETE FROM passes WHERE id = ?', [id]),
      },
    ];
    for (const change of changes) {
      const scanner = await kit.scanner({ templateIds: [tpl] });
      const pass = await kit.scanPass(tpl);
      const idempotencyKey = key();
      const original = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
      expect(original.kind, change.name).toBe('ok');
      if (change.name === 'hard deleted') {
        expect(
          await first(
            kit.env.DB,
            'SELECT scan_id, excluded FROM scan_retention_proofs WHERE scan_id = ?',
            [original.scanId ?? ''],
          ),
        ).toEqual({ scan_id: original.scanId, excluded: 0 });
      }
      await change.apply(pass.id);
      const response = await act(scanner.headers, codeOf(pass), { idempotencyKey });
      expect(response.status, change.name).toBe(200);
      const replay = await out(response);
      if (change.name === 'quarantined') expectUnavailable(replay);
      else expectRedactedReceipt(replay, original);
      const text = JSON.stringify(replay);
      if (pass.scanCode === null) throw new Error('Missing pass scan code');
      for (const forbidden of ['Anna Popescu', pass.id, pass.serial, pass.scanCode])
        expect(text, change.name).not.toContain(forbidden);
      expect(
        await first(kit.env.DB, 'SELECT state, outcome, reason FROM scans WHERE id = ?', [
          original.scanId ?? '',
        ]),
        change.name,
      ).toEqual({ state: 'done', outcome: 'ok', reason: null });
      if (change.name === 'hard deleted') {
        expect(
          await first(
            kit.env.DB,
            'SELECT scan_id, excluded FROM scan_retention_proofs WHERE scan_id = ?',
            [original.scanId ?? ''],
          ),
        ).toEqual({ scan_id: original.scanId, excluded: 0 });
        expect(
          await rows("SELECT id FROM pass_events WHERE pass_id = ? AND kind = 'scan.checked_in'", [
            pass.id,
          ]),
        ).toHaveLength(0);
      } else {
        await expectOriginalLedger(pass.id, original.scanId);
      }
    }
  });

  it.each(['missing proof', 'quarantined at deletion'] as const)(
    'refuses a hard-deleted pass with %s',
    async (change) => {
      const scanner = await kit.scanner({ mode: 'test', templateIds: [tpl] });
      const pass = await kit.scanPass(tpl, {}, { mode: 'test' });
      const idempotencyKey = key();
      const original = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
      expect(original.kind).toBe('ok');
      const scanId = original.scanId ?? '';
      expect(
        await first(
          kit.env.DB,
          'SELECT scan_id, excluded FROM scan_retention_proofs WHERE scan_id = ?',
          [scanId],
        ),
      ).toEqual({ scan_id: scanId, excluded: 0 });
      if (change === 'missing proof') {
        // Simulate a pre-retention scan using the real completed row and its signed event.
        const temporaryId = kit.fx.ids.id();
        await run(
          kit.env.DB,
          `INSERT INTO scans (
          id,org_id,mode,pass_id,template_id,scanner_id,event_id,actor_type,actor_id,actor_key,staff_id,
          approved_by,idempotency_key,request_hash,method,state,outcome,reason,action_id,action_kind,
          direction,amount,before_value,after_value,override_of,group_id,offline,pass_version,notified,
          undoes,undone_by,undone_at,client_ts,at,presence_scope
        ) SELECT ?,org_id,mode,pass_id,template_id,scanner_id,event_id,actor_type,actor_id,actor_key,staff_id,
          approved_by,?,request_hash,method,state,outcome,reason,action_id,action_kind,
          direction,amount,before_value,after_value,override_of,group_id,offline,pass_version,notified,
          undoes,undone_by,undone_at,client_ts,at,presence_scope FROM scans WHERE id = ?`,
          [temporaryId, key(), scanId],
        );
        await run(kit.env.DB, 'DELETE FROM scans WHERE id = ?', [scanId]);
        await run(kit.env.DB, 'UPDATE scans SET id = ?, idempotency_key = ? WHERE id = ?', [
          scanId,
          idempotencyKey,
          temporaryId,
        ]);
        await expectOriginalLedger(pass.id, original.scanId);
      } else {
        await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [
          pass.id,
        ]);
      }
      await run(kit.env.DB, 'DELETE FROM passes WHERE id = ?', [pass.id]);
      expect(
        await first(
          kit.env.DB,
          'SELECT scan_id, excluded FROM scan_retention_proofs WHERE scan_id = ?',
          [scanId],
        ),
      ).toEqual(change === 'missing proof' ? null : { scan_id: scanId, excluded: 1 });
      expectUnavailable(await out(await act(scanner.headers, codeOf(pass), { idempotencyKey })));
      expect(
        await rows("SELECT id FROM pass_events WHERE pass_id = ? AND kind LIKE 'scan.%'", [
          pass.id,
        ]),
      ).toHaveLength(0);
    },
  );

  it('refuses a retained hard-delete receipt outside the current scanner scope', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const idempotencyKey = key();
    const original = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
    expect(original.kind).toBe('ok');
    await run(kit.env.DB, 'DELETE FROM passes WHERE id = ?', [pass.id]);
    expect(
      await first(
        kit.env.DB,
        'SELECT scan_id, excluded FROM scan_retention_proofs WHERE scan_id = ?',
        [original.scanId ?? ''],
      ),
    ).toEqual({ scan_id: original.scanId, excluded: 0 });
    await run(
      kit.env.DB,
      'DELETE FROM scanner_templates WHERE scanner_id = ? AND template_id = ?',
      [scanner.id, tpl],
    );
    expectUnavailable(
      await out(await act(scanner.headers, codeOf(pass), { idempotencyKey })),
      'not_accepted',
    );
    expect(
      await first(kit.env.DB, 'SELECT outcome FROM scans WHERE id = ?', [original.scanId ?? '']),
    ).toEqual({ outcome: 'ok' });
  });

  it('keeps an originally refused scan refused when the pass later becomes eligible', async () => {
    const template = await kit.scanTemplate('Timed replay', {
      actions: [CHECK_IN],
      window: { from: 'startsAt' },
    });
    const scanner = await kit.scanner({ templateIds: [template] });
    const pass = await kit.scanPass(template, {
      startsAt: new Date(kit.clock.now() + HOUR).toISOString(),
    });
    const idempotencyKey = key();
    const original = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
    expect(original).toMatchObject({ kind: 'heads_up', reason: 'not_yet_valid' });
    kit.clock.advance(HOUR + MINUTE);
    const replay = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
    expectReceipt(replay, original);
  });
}
