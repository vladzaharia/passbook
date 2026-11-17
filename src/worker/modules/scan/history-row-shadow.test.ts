import { describe, expect, it } from 'vitest';
import { all, run } from '../../platform/db.ts';
import {
  credentialRefKeysetCommitment,
  ensureCredentialRefKeyset,
} from '../passes/credential-keyset.ts';
import { recordedCheckIn, recordedNoMatch } from './console-privacy-actions-test-fixtures.ts';
import { kit, PUBLIC, setupPrivacyKit, templateId } from './console-privacy-test-fixtures.ts';
import { type HistoryRaw, policyCandidateOf, projectionCurrentOf } from './history-row.ts';
import { scanLedgerScopeSql } from './repo-feed-scope.ts';
import { type HistoryProofRow, historyProofRowsStmt } from './repo-history-proof-read.ts';
import { policyCandidateSql as oldPolicyCandidateSql } from './repo-history-row-shadow-test-fixtures.ts';
import { testFence } from './repo-history-row-test-support.ts';
import { readHistoryPage } from './repo-history-rows.ts';

setupPrivacyKit();

/*
 * The drift gate for the history row flags. The old builders (`policyCandidateSql` of the feed and
 * the history proof read's `projection_current`) answer from separate statements; the page
 * statement splits them into column flags over joined aliases and combines them in JS. Each state
 * below is read both ways, row by row, and the answers must be identical.
 */

async function newRows() {
  const { authorized, rows } = await readHistoryPage(
    kit.env.DB,
    testFence(kit.org.id),
    { where: scanLedgerScopeSql('s'), params: [], limit: 500 },
    kit.clock.now(),
  );
  expect(authorized).toBe(true);
  return new Map(rows.map((row) => [row.id, row.raw]));
}

async function oldFlags(ids: readonly string[]) {
  const now = kit.clock.now();
  const candidates = await all<{ id: string; pc: number }>(
    kit.env.DB,
    `SELECT s.id, ${oldPolicyCandidateSql('s')} AS pc FROM scans s
     WHERE s.id IN (${ids.map(() => '?').join(',')})`,
    [now, ...ids],
  );
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
  const commitment = await credentialRefKeysetCommitment(kit.env);
  const proofs = (
    await historyProofRowsStmt(
      kit.ctx,
      { ids },
      's.org_id=? AND s.mode=?',
      [kit.org.id, 'live'],
      commitment,
    ).all<HistoryProofRow>()
  ).results;
  return {
    policy: new Map(candidates.map((row) => [row.id, row.pc === 1])),
    proof: new Map(proofs.map((row) => [row.id, row])),
  };
}

interface Case {
  name: string;
  scanId: string;
}

/** Compare every case under the current database state; returns how many rows were compared. */
async function compare(cases: readonly Case[]) {
  const fresh = await newRows();
  const old = await oldFlags(cases.map((c) => c.scanId));
  const seen: string[] = [];
  const answers = { policy: new Set<boolean>(), projection: new Set<boolean>() };
  for (const { name, scanId } of cases) {
    const raw: HistoryRaw | undefined = fresh.get(scanId);
    if (!raw) continue; // Out of the ledger scope: neither read can show it.
    seen.push(name);
    expect(policyCandidateOf(raw), `${name}: policy candidate`).toBe(old.policy.get(scanId));
    answers.policy.add(policyCandidateOf(raw));
    const proof = old.proof.get(scanId);
    if (proof) {
      expect(projectionCurrentOf(raw), `${name}: projection current`).toBe(
        proof.projection_current === 1,
      );
      answers.projection.add(projectionCurrentOf(raw));
      expect(raw.approved_proof, `${name}: approved proof`).toBe(proof.approved_proof);
      expect(raw.legacy_proof, `${name}: legacy proof`).toBe(proof.legacy_proof);
    }
  }
  return { seen, answers };
}

describe('history row flags against the old builders', () => {
  it('answer alike over a varied fixture set', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const cases: Case[] = [];
    const pass = async (name: string) => {
      const created = await kit.scanPass(templateId, { memberName: `${PUBLIC} ${name}` });
      const scan = await recordedCheckIn(scanner, created.id);
      cases.push({ name, scanId: scan.id });
      return { passId: created.id, scanId: scan.id };
    };
    const db = kit.env.DB;
    const at = kit.clock.now();

    await pass('baseline');
    const voided = await pass('voided pass');
    await run(db, "UPDATE passes SET status = 'voided' WHERE id = ?", [voided.passId]);
    const removed = await pass('removed pass');
    await run(db, 'UPDATE passes SET removed_at = ? WHERE id = ?', [at, removed.passId]);
    const badPersonalization = await pass('personalization not an object');
    await run(db, "UPDATE passes SET personalization = '[]' WHERE id = ?", [
      badPersonalization.passId,
    ]);
    const expired = await pass('expired wallet');
    await run(
      db,
      `UPDATE pass_versions SET pass_json = json_set(pass_json, '$.expirationDate', '2000-01-01T00:00:00Z')
       WHERE pass_id = ?`,
      [expired.passId],
    );
    const voidedWallet = await pass('voided wallet');
    await run(
      db,
      `UPDATE pass_versions SET pass_json = json_set(pass_json, '$.voided', json('true'))
       WHERE pass_id = ?`,
      [voidedWallet.passId],
    );
    const noRelease = await pass('legacy release');
    await run(db, 'UPDATE passes SET release_id = NULL WHERE id = ?', [noRelease.passId]);
    const wrongClass = await pass('release class tampered');
    await run(
      db,
      "UPDATE pass_events SET data = json_set(data, '$.authority.releaseClass', 'legacy') WHERE pass_id = ?",
      [wrongClass.passId],
    );
    const lineage = await pass('lineage tampered');
    await run(
      db,
      "UPDATE pass_events SET data = json_set(data, '$.authority.credentialGeneration', 7) WHERE pass_id = ?",
      [lineage.passId],
    );
    const walletVersion = await pass('wallet version tampered');
    await run(
      db,
      "UPDATE pass_events SET data = json_set(data, '$.authority.walletVersion', 99) WHERE pass_id = ?",
      [walletVersion.passId],
    );
    const untyped = await pass('wallet version as text');
    await run(
      db,
      "UPDATE pass_events SET data = json_set(data, '$.authority.walletVersion', '1') WHERE pass_id = ?",
      [untyped.passId],
    );
    const garbled = await pass('event authority not an object');
    await run(
      db,
      "UPDATE pass_events SET data = json_set(data, '$.authority', 'x') WHERE pass_id = ?",
      [garbled.passId],
    );
    const restored = await pass('removed then restored pass');
    await run(db, 'UPDATE passes SET removed_at = ? WHERE id = ?', [at, restored.passId]);
    await run(db, 'UPDATE passes SET removed_at = NULL WHERE id = ?', [restored.passId]);
    for (const [name, enabled] of [
      ['enabled connection', 1],
      ['disabled connection', 0],
    ] as const) {
      const linked = await pass(name);
      const connectionId = `conn-${enabled}`;
      await run(
        db,
        `INSERT INTO connections (id, org_id, connector_type, name, enabled, generation, created_at, updated_at)
         VALUES (?, ?, 'test', ?, ?, 1, ?, ?)`,
        [connectionId, kit.org.id, name, enabled, at, at],
      );
      await run(db, 'UPDATE passes SET connection_id = ? WHERE id = ?', [
        connectionId,
        linked.passId,
      ]);
    }
    const noMatch = await recordedNoMatch(scanner);
    cases.push({ name: 'passless refusal', scanId: noMatch.id });

    const other = await kit.scanTemplate('Shadow template', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'always' }],
    });
    const second = await kit.scanner({ templateIds: [other] });
    const doomed = await kit.scanPass(other, { memberName: 'Doomed' });
    const doomedScan = await recordedCheckIn(second, doomed.id);
    cases.push({ name: 'deleted template', scanId: doomedScan.id });

    const first = await compare(cases);
    // The fixtures must reach the page and vary: an agreement over one answer proves nothing.
    expect(first.seen).toEqual(
      expect.arrayContaining(['baseline', 'voided pass', 'passless refusal']),
    );
    expect(first.seen.length).toBeGreaterThan(8);
    expect([...first.answers.policy].sort()).toEqual([false, true]);
    expect([...first.answers.projection].sort()).toEqual([false, true]);

    await run(db, "UPDATE templates SET status = 'deleted' WHERE id = ?", [other]);
    expect((await compare(cases)).seen).toContain('deleted template');

    await run(db, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [kit.org.id]);
    await compare(cases);
  });
});
