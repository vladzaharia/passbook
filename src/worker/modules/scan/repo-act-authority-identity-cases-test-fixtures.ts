import { expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { expectBlocked, raceGate } from './act-authority-test-fixtures.ts';
import { act, kit, out, retireCredential, rows, tpl } from './act-test-fixtures.ts';
import { credentialTombstoneRefsForInput } from './credential-input.ts';
import { commitBatchSql } from './repo-act-support-test-fixtures.ts';
import { codeOf, key, startScanCredentialTransfer } from './test-kit.ts';

export function registerAuthorityIdentity() {
  // Liveness: a signing-identity edit is content, not authority. The refusal for the voided pass is still
  // true, so it is recorded once.
  it.each(['identity ABA', 'pass type', 'team'] as const)(
    'records the voided refusal after a signing identity %s change at commit',
    async (change) => {
      const scanner = await kit.scanner({ mode: 'test', templateIds: [tpl] });
      const pass = await kit.scanPass(tpl, {}, { mode: 'test' });
      await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [pass.id]);
      const identity = await first<{ pass_type_identifier: string; team_identifier: string }>(
        kit.env.DB,
        'SELECT pass_type_identifier, team_identifier FROM signing_identities WHERE id = ?',
        [pass.identityId],
      );
      if (!identity) throw new Error('Missing signing identity');
      const set = (db: D1Database, team: string, type: string) =>
        run(
          db,
          'UPDATE signing_identities SET team_identifier = ?, pass_type_identifier = ? WHERE id = ?',
          [team, type, pass.identityId],
        );
      try {
        const response = await raceGate(
          scanner.headers,
          { passId: pass.id, method: 'manual' },
          async (db) => {
            const changed = {
              team:
                change === 'pass type' ? identity.team_identifier : `${identity.team_identifier}-x`,
              type:
                change === 'pass type'
                  ? `${identity.pass_type_identifier}.changed`
                  : identity.pass_type_identifier,
            };
            await set(db, changed.team, changed.type);
            if (change === 'identity ABA')
              await set(db, identity.team_identifier, identity.pass_type_identifier);
          },
          { idempotencyKey: key() },
          commitBatchSql,
        );
        expect(response.status).toBe(200);
        expect(await out(response)).toMatchObject({ kind: 'refused', reason: 'voided' });
        expect(
          await all(
            kit.env.DB,
            "SELECT id FROM pass_events WHERE pass_id = ? AND kind = 'scan.rejected'",
            [pass.id],
          ),
        ).toHaveLength(1);
      } finally {
        await set(kit.env.DB, identity.team_identifier, identity.pass_type_identifier);
      }
    },
  );

  it('refuses with SCAN_PASS_CHANGED when a credential transfer rotates the serial before commit', async () => {
    const scanner = await kit.scanner({ mode: 'test', templateIds: [tpl] });
    const pass = await kit.scanPass(tpl, {}, { mode: 'test' });
    await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [pass.id]);
    const idempotencyKey = key();
    const response = await raceGate(
      scanner.headers,
      { passId: pass.id, method: 'manual' },
      async (db) => {
        await run(db, "UPDATE passes SET status='active' WHERE id=?", [pass.id]);
        try {
          expect((await startScanCredentialTransfer(kit, pass.id, { db })).state).toBe('completed');
        } finally {
          await run(db, "UPDATE passes SET status='voided' WHERE id=?", [pass.id]);
        }
      },
      { idempotencyKey },
      commitBatchSql,
    );
    await expectBlocked(response, pass.id, idempotencyKey, 'SCAN_PASS_CHANGED');
  });

  it('rejects an unreserved signing identity replacement before an inactive-pass decision', async () => {
    const scanner = await kit.scanner({ mode: 'test', templateIds: [tpl] });
    const pass = await kit.scanPass(tpl, {}, { mode: 'test' });
    await run(kit.env.DB, "UPDATE passes SET status='voided' WHERE id=?", [pass.id]);
    const otherIdentity = kit.fx.ids.id();
    await run(
      kit.env.DB,
      `INSERT INTO signing_identities
      (id, org_id, label, pass_type_identifier, team_identifier, source, env_prefix, created_at)
      SELECT ?, org_id, 'Audit identity', pass_type_identifier || ?, team_identifier, 'env',
        COALESCE(env_prefix, 'PLATFORM'), ? FROM signing_identities WHERE id=?`,
      [otherIdentity, `.${otherIdentity}`, kit.clock.now(), pass.identityId],
    );
    await expect(
      run(kit.env.DB, 'UPDATE passes SET identity_id=? WHERE id=?', [otherIdentity, pass.id]),
    ).rejects.toThrow('credential transfer required');
    expect(await first(kit.env.DB, 'SELECT identity_id FROM passes WHERE id=?', [pass.id])).toEqual(
      { identity_id: pass.identityId },
    );
    const response = await act(scanner.headers, { passId: pass.id, method: 'manual' });
    expect(response.status).toBe(200);
    expect(await out(response)).toMatchObject({ kind: 'refused', reason: 'voided' });
  });

  it('does not finalize a refusal after the scanner becomes a monitor', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    await run(kit.env.DB, "UPDATE passes SET status='voided' WHERE id=?", [pass.id]);
    const idempotencyKey = key();
    const response = await raceGate(
      s.headers,
      codeOf(pass),
      (db) => run(db, "UPDATE scanners SET device_role='monitor' WHERE id=?", [s.id]),
      { idempotencyKey },
      commitBatchSql,
    );
    await expectBlocked(response, pass.id, idempotencyKey, 'SCAN_CONFIG_CHANGED');
  });

  it.each(['quarantine', 'screen'] as const)(
    'does not finalize a losing-gate heads-up after %s',
    async (change) => {
      const s = await kit.scanner({ mode: 'test', templateIds: [tpl] });
      const pass = await kit.scanPass(tpl, {}, { mode: 'test' });
      expect((await out(await act(s.headers, codeOf(pass)))).kind).toBe('ok');
      const idempotencyKey = key();
      const response = await raceGate(
        s.headers,
        codeOf(pass),
        (db) =>
          change === 'quarantine'
            ? run(db, 'UPDATE passes SET test_data_quarantined=1 WHERE id=?', [pass.id])
            : run(db, "UPDATE scanners SET device_role='monitor' WHERE id=?", [s.id]),
        { idempotencyKey },
        commitBatchSql,
      );
      // The winning check-in stays; the refused heads-up leaves no gate change, event or claim.
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: change === 'quarantine' ? 'SCAN_PASS_CHANGED' : 'SCAN_CONFIG_CHANGED',
      });
      expect(await rows('SELECT count FROM scan_gates WHERE pass_id=?', [pass.id])).toEqual([
        { count: 1 },
      ]);
      expect(
        await rows("SELECT id FROM pass_events WHERE pass_id=? AND kind='scan.heads_up'", [
          pass.id,
        ]),
      ).toHaveLength(0);
      const claim = await first<{ state: string; outcome: string | null }>(
        kit.env.DB,
        'SELECT state,outcome FROM scans WHERE idempotency_key=?',
        [idempotencyKey],
      );
      expect(claim === null || (claim.state === 'failed' && claim.outcome === null)).toBe(true);
    },
  );

  it('does not reveal or persist a mode mismatch after the actor is revoked', async () => {
    const scanner = await kit.scanner({ mode: 'live', templateIds: [tpl] });
    const pass = await kit.scanPass(
      tpl,
      { memberName: 'Revoked Cross Mode Person' },
      { mode: 'test' },
    );
    const idempotencyKey = key();
    const response = await raceGate(
      scanner.headers,
      codeOf(pass),
      (db) => run(db, 'UPDATE scanners SET revoked_at=? WHERE id=?', [kit.clock.now(), scanner.id]),
      { idempotencyKey },
      commitBatchSql,
    );
    // scanners.credential_epoch moved: re-pair, and nothing about the other-mode pass is revealed.
    await expectBlocked(response, pass.id, idempotencyKey, 'SCANNER_REPAIR');
    expect(
      await rows("SELECT id FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'", [pass.id]),
    ).toHaveLength(0);
  });

  it('returns only the generic cross-mode refusal when its credential retires during evaluation', async () => {
    const scanner = await kit.scanner({ mode: 'live', templateIds: [tpl] });
    const pass = await kit.scanPass(tpl, {}, { mode: 'test' });
    const input = codeOf(pass);
    const refs = await credentialTombstoneRefsForInput(kit.ctx, kit.org.id, 'live', input);
    const otherModeCredentialRef = refs.otherModeCredentialTombstoneRefs[0];
    if (otherModeCredentialRef === undefined) throw new Error('Missing other-mode credential ref');
    const idempotencyKey = key();
    const response = await raceGate(
      scanner.headers,
      input,
      (db) => retireCredential(db, pass.id, otherModeCredentialRef),
      { idempotencyKey },
      commitBatchSql,
    );
    // The retired credential is not authority: the generic cross-mode reason is returned, with no pass detail.
    expect(await out(response)).toMatchObject({
      kind: 'refused',
      reason: 'test_pass',
      scanId: null,
      display: null,
    });
    expect(
      await rows("SELECT id FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'", [pass.id]),
    ).toHaveLength(0);
  }, 60_000);
}
