import { expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { act as actService } from './act.ts';
import {
  act,
  expectReceipt,
  expectRedactedReceipt,
  expectUnavailable,
  kit,
  out,
  tpl,
} from './act-test-fixtures.ts';
import { scannerActor, withRole } from './actor.ts';
import { getScanner } from './repo-device.ts';
import { candidateById } from './repo-lookup.ts';
import { scanByKey } from './repo-scans.ts';
import { readScannerScope } from './repo-scope.ts';
import { codeOf, key, proofedScanActor } from './test-kit.ts';

export function registerReplayProvenance() {
  // The replay candidate and its checks are one batch now, so there is no read-then-recheck window
  // to hook; each change lands before the replay and the receipt must be redacted.
  it('redacts a replay after the pass, connection generation, source or scanner scope changes', async () => {
    for (const change of ['quarantine', 'generation', 'snapshot', 'scope', 'revocation'] as const) {
      const scanner = await kit.scanner({ templateIds: [tpl] });
      const pass = await kit.scanPass(tpl);
      const idempotencyKey = key();
      const real = kit.env.DB;
      const connection = kit.fx.ids.id();
      if (change === 'generation') {
        await run(
          real,
          "INSERT INTO connections (id, org_id, connector_type, name, created_at, updated_at) VALUES (?, ?, 'fixture', 'Replay source', ?, ?)",
          [connection, kit.org.id, kit.clock.now(), kit.clock.now()],
        );
        await run(real, 'UPDATE passes SET connection_id = ?, external_ref = ? WHERE id = ?', [
          connection,
          'member',
          pass.id,
        ]);
      }
      const original = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
      expect(original.kind, change).toBe('ok');
      if (change === 'quarantine')
        await run(real, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [pass.id]);
      else if (change === 'generation')
        await run(real, 'UPDATE connections SET generation = generation + 1 WHERE id = ?', [
          connection,
        ]);
      else if (change === 'snapshot')
        await run(
          real,
          "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.voided', json('true')) WHERE pass_id = ?",
          [pass.id],
        );
      else if (change === 'scope')
        await run(real, 'DELETE FROM scanner_templates WHERE scanner_id = ? AND template_id = ?', [
          scanner.id,
          tpl,
        ]);
      else
        await run(real, 'UPDATE scanners SET revoked_at = ? WHERE id = ?', [
          kit.clock.now(),
          scanner.id,
        ]);
      const response = await act(scanner.headers, codeOf(pass), { idempotencyKey });
      if (change === 'revocation') {
        expect(response.status, change).toBe(401);
        expect(await response.json()).toMatchObject({ code: 'SCANNER_REVOKED' });
      } else {
        const replay = await out(response);
        if (change === 'generation' || change === 'snapshot')
          expectRedactedReceipt(replay, original);
        else expectUnavailable(replay, change === 'scope' ? 'not_accepted' : 'not_found');
        expect(JSON.stringify(replay), change).not.toContain('Anna Popescu');
      }
      expect(
        await first(real, 'SELECT outcome, reason FROM scans WHERE id = ?', [
          original.scanId ?? '',
        ]),
        change,
      ).toEqual({ outcome: 'ok', reason: null });
      expect(
        await all(
          real,
          "SELECT id FROM pass_events WHERE pass_id = ? AND kind = 'scan.checked_in'",
          [pass.id],
        ),
        change,
      ).toHaveLength(1);
    }
  });

  it('keeps original evaluated provenance internal on fresh and replay outcomes', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl, { memberName: 'Provenance Member' });
    const scannerRow = await getScanner(kit.env.DB, scanner.id);
    if (!scannerRow) throw new Error('Missing scanner');
    const scope = await readScannerScope(kit.env.DB, scannerRow, null);
    const actor = await proofedScanActor(
      kit.ctx,
      withRole(scannerActor(kit.ctx, scannerRow, scannerRow.mode, 'cookie', scope), null),
    );
    const req = {
      idempotencyKey: key(),
      input: codeOf(pass),
      actionId: 'auto',
      clientTs: kit.clock.now(),
    };
    const fresh = await actService(kit.ctx, actor, req);
    expect(fresh.outcome.kind).toBe('ok');
    expect(fresh.evaluatedSnapshot).toMatchObject({
      pass: { id: pass.id, version: pass.version },
      orgRevision: expect.any(Number),
      templateRevision: expect.any(Number),
    });
    expect(fresh.outcome).not.toHaveProperty('evaluatedSnapshot');
    const replay = await actService(kit.ctx, actor, req);
    expectReceipt(replay.outcome, fresh.outcome);
    expect(replay.evaluatedSnapshot).toEqual(fresh.evaluatedSnapshot);
    expect(replay.outcome).not.toHaveProperty('evaluatedSnapshot');
  });
}
