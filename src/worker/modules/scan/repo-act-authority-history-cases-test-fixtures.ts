import { expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { expectAdmitted, expectBlocked, raceGate } from './act-authority-test-fixtures.ts';
import { act, kit, out, rows, tpl } from './act-test-fixtures.ts';
import { commitBatchSql } from './repo-act-support-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

export function registerAuthorityHistory() {
  // Liveness: the link generation is volatile (passes.row_version moves, no scan guard reads it).
  it('admits an override of a heads-up after the pass link generation changes', async () => {
    const s = await kit.scanner({ templateIds: [tpl], settings: { letInAgain: 'anyone' } });
    const pass = await kit.scanPass(tpl);
    expect((await out(await act(s.headers, codeOf(pass)))).kind).toBe('ok');
    const stopped = await out(await act(s.headers, codeOf(pass)));
    expect(stopped.reason).toBe('already_done');
    await run(kit.env.DB, 'UPDATE passes SET link_generation=link_generation+1 WHERE id=?', [
      pass.id,
    ]);
    const response = await act(s.headers, codeOf(pass), { overrideOf: stopped.scanId });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: 'ok', scanId: expect.any(String) });
  });

  it('admits the scan after a source connection generation changes', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const connectionId = kit.fx.ids.id();
    await run(
      kit.env.DB,
      `INSERT INTO connections
      (id,org_id,connector_type,name,created_at,updated_at) VALUES (?,?,'test',?,?,?)`,
      [connectionId, kit.org.id, `scanner-${connectionId}`, kit.clock.now(), kit.clock.now()],
    );
    await run(kit.env.DB, 'UPDATE passes SET connection_id=?,external_ref=? WHERE id=?', [
      connectionId,
      'external',
      pass.id,
    ]);
    const idempotencyKey = key();
    const response = await raceGate(
      s.headers,
      codeOf(pass),
      (db) => run(db, 'UPDATE connections SET generation=generation+1 WHERE id=?', [connectionId]),
      { idempotencyKey },
    );
    await expectAdmitted(response, pass.id);
  });

  it('links a removed-pass refusal to its audit ledger without disclosing the internal snapshot', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(
      tpl,
      { memberName: 'Private Snapshot Person' },
      {
        holderEmail: 'snapshot-private@example.test',
      },
    );
    await run(kit.env.DB, 'UPDATE passes SET removed_at=? WHERE id=?', [kit.clock.now(), pass.id]);
    const response = await act(s.headers, codeOf(pass));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ kind: 'refused', reason: 'removed', display: null });
    for (const secret of [
      pass.id,
      pass.scanCode ?? '',
      'Private Snapshot Person',
      'snapshot-private@example.test',
      'auditPassId',
      'auditPassSnapshot',
      'linkGeneration',
    ]) {
      if (secret) expect(body).not.toContain(secret);
    }
    expect(
      await rows("SELECT pass_id FROM pass_events WHERE pass_id=? AND kind='scan.rejected'", [
        pass.id,
      ]),
    ).toEqual([{ pass_id: pass.id }]);
  });

  it.each([
    ['quarantine', 'test_data_quarantined=1', true],
    ['void', "status='voided'", true],
    ['removal', 'removed_at=1', true],
    ['deletion', 'deleted_at=1', true],
    ['lifecycle generation', 'lifecycle_generation=lifecycle_generation+1', true],
    // A publish or sync is not a reason to refuse a ticket (epochs: content is not authority).
    ['version change', 'version=version+1', false],
    ['link generation change', 'link_generation=link_generation+1', false],
  ])(
    'on a concurrent %s the commit is refused only if the pass was withdrawn',
    async (_change, set, refused) => {
      const s = await kit.scanner({ mode: 'test', templateIds: [tpl] });
      const pass = await kit.scanPass(tpl, {}, { mode: 'test' });
      const idempotencyKey = key();
      const response = await raceGate(
        s.headers,
        codeOf(pass),
        (db) => run(db, `UPDATE passes SET ${set} WHERE id=?`, [pass.id]),
        { idempotencyKey },
      );
      if (refused) await expectBlocked(response, pass.id, idempotencyKey, 'SCAN_PASS_CHANGED');
      else await expectAdmitted(response, pass.id);
    },
  );

  it.each([
    ['replacement', "pass_json = json_set(pass_json, '$.description', 'changed')"],
    ['voiding', "pass_json = json_set(pass_json, '$.voided', json('true'))"],
    ['expiry', "pass_json = json_set(pass_json, '$.expirationDate', '2000-01-01T00:00:00Z')"],
    ['purge', 'pass_json = NULL, purged_at = 1'],
  ])(
    'admits the scan after a Wallet JSON %s (content is not authority)',
    async (_change, mutation) => {
      const scanner = await kit.scanner({ mode: 'test', templateIds: [tpl] });
      const pass = await kit.scanPass(tpl, {}, { mode: 'test' });
      const idempotencyKey = key();
      const response = await raceGate(
        scanner.headers,
        codeOf(pass),
        (db) =>
          run(
            db,
            `UPDATE pass_versions SET ${mutation}
        WHERE pass_id = ? AND version = ?`,
            [pass.id, pass.version],
          ),
        { idempotencyKey },
      );
      await expectAdmitted(response, pass.id);
    },
  );

  it('admits the scan after a signing-identity team A→B→A race', async () => {
    const scanner = await kit.scanner({ mode: 'test', templateIds: [tpl] });
    const pass = await kit.scanPass(tpl, {}, { mode: 'test' });
    const identity = await first<{ team_identifier: string; revision: number }>(
      kit.env.DB,
      'SELECT team_identifier, revision FROM signing_identities WHERE id = ?',
      [pass.identityId],
    );
    if (!identity) throw new Error('Missing signing identity');
    const idempotencyKey = key();
    const response = await raceGate(
      scanner.headers,
      codeOf(pass),
      async (db) => {
        try {
          await run(db, 'UPDATE signing_identities SET team_identifier = ? WHERE id = ?', [
            `${identity.team_identifier}-changed`,
            pass.identityId,
          ]);
        } finally {
          await run(db, 'UPDATE signing_identities SET team_identifier = ? WHERE id = ?', [
            identity.team_identifier,
            pass.identityId,
          ]);
        }
      },
      { idempotencyKey },
    );
    const current = await first<{ team_identifier: string; revision: number }>(
      kit.env.DB,
      'SELECT team_identifier, revision FROM signing_identities WHERE id = ?',
      [pass.identityId],
    );
    expect(current?.team_identifier).toBe(identity.team_identifier);
    if (!current) throw new Error('Missing signing identity');
    expect(current.revision).toBeGreaterThan(identity.revision);
    await expectAdmitted(response, pass.id);
  });

  it.each([
    ['quarantine', 'test_data_quarantined=1', true],
    // The connection link is not authority: the refusal is still true, so it is recorded.
    ['link generation change', 'link_generation=link_generation+1', false],
    ['restoration', "status='active'", true],
  ])(
    'a stale refusal after %s is refused only if the pass moved',
    async (_change, set, refused) => {
      const s = await kit.scanner({ mode: 'test', templateIds: [tpl] });
      const pass = await kit.scanPass(tpl, {}, { mode: 'test' });
      await run(kit.env.DB, "UPDATE passes SET status='voided' WHERE id=?", [pass.id]);
      const idempotencyKey = key();
      const response = await raceGate(
        s.headers,
        codeOf(pass),
        (db) => run(db, `UPDATE passes SET ${set} WHERE id=?`, [pass.id]),
        { idempotencyKey },
        commitBatchSql,
      );
      if (refused) await expectBlocked(response, pass.id, idempotencyKey, 'SCAN_PASS_CHANGED');
      else expect(response.status).toBe(200);
    },
  );
}
