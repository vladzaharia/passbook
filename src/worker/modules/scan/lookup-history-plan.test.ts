import { beforeAll, describe, expect, it } from 'vitest';
import { stagePendingCredentialTransfer } from '../../../../test/helpers/credential-transfer.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { run } from '../../platform/db.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { planHistoryProofSnapshotsForOrg } from './history-proof-plan.ts';
import { lookupHistoryStmts } from './lookup-history.ts';
import { codeOf, key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let credentialKeysetCommitment: string;
beforeAll(async () => {
  kit = await setupScanKit();
  credentialKeysetCommitment = await ensureCredentialRefKeyset(kit.env.DB, kit.env);
});

async function lastScan() {
  const template = await kit.scanTemplate('Lookup history plan', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
  const scanner = await kit.scanner({ templateIds: [template] });
  const pass = await kit.scanPass(template);
  const response = await kit.post(scanner.headers, '/actions', {
    input: codeOf(pass),
    idempotencyKey: key(),
    clientTs: kit.clock.now(),
    actionId: 'check_in',
  });
  expect(response.status).toBe(200);
  const { scanId } = (await response.json()) as ScanOutcome;
  if (!scanId) throw new Error('Missing scan ID');
  const scope = { orgId: kit.org.id, mode: 'live' as const, credentialKeysetCommitment };
  return { pass, scanId, scope };
}

describe('lookup history plan', () => {
  it('reads the scan ids it was given, once, and proves nothing it did not ask for', async () => {
    const { scanId, scope } = await lastScan();
    const plannedIds = [scanId];
    const plan = planHistoryProofSnapshotsForOrg(kit.ctx, scope, plannedIds);
    plannedIds[0] = 'foreign-scan';
    expect(plan.stmts).toHaveLength(1);
    const results = await kit.env.DB.batch(plan.stmts);
    expect((await plan.finish(results)).has(scanId)).toBe(true);
    expect((await plan.finish(results)).size).toBe(0);
    const missing = planHistoryProofSnapshotsForOrg(kit.ctx, scope, [scanId]);
    expect((await missing.finish([])).size).toBe(0);
    const other = planHistoryProofSnapshotsForOrg(kit.ctx, scope, ['another-scan']);
    expect((await other.finish(await kit.env.DB.batch(other.stmts))).size).toBe(0);
    const badKeyset = planHistoryProofSnapshotsForOrg(
      kit.ctx,
      { ...scope, credentialKeysetCommitment: 'invalid' },
      [scanId],
    );
    expect(badKeyset.stmts).toHaveLength(0);
  });

  it('splits many scan ids into statements of at most fifty binds each', () => {
    const plan = planHistoryProofSnapshotsForOrg(
      kit.ctx,
      { orgId: kit.org.id, mode: 'live', credentialKeysetCommitment },
      Array.from({ length: 101 }, (_, index) => `missing-${index}`),
    );
    expect(plan.stmts).toHaveLength(3);
  });

  it('rejects a page of another tenant or mode', async () => {
    const { scanId, scope } = await lastScan();
    const plan = planHistoryProofSnapshotsForOrg(kit.ctx, { ...scope, mode: 'test' }, [scanId]);
    // The same scan id read under the other mode is outside the ledger scope: no row, no proof.
    expect((await plan.finish(await kit.env.DB.batch(plan.stmts))).size).toBe(0);
  });

  it('fences the proof on the scan and the pass lineage, and goes stale when the pass moves', async () => {
    const { pass, scanId, scope } = await lastScan();
    const plan = planHistoryProofSnapshotsForOrg(kit.ctx, scope, [scanId]);
    const proof = (await plan.finish(await kit.env.DB.batch(plan.stmts))).get(scanId);
    if (!proof) throw new Error('Missing last-scan proof');
    const stmts = lookupHistoryStmts(kit.env.DB, proof, kit.clock.now());
    expect(stmts).toHaveLength(1);
    const authorized = async () =>
      (await Promise.all(stmts.map((stmt) => stmt.first<{ authorized: number }>()))).map(
        (row) => row?.authorized,
      );
    expect(await authorized()).toEqual([1]);
    await run(
      kit.env.DB,
      'UPDATE passes SET lifecycle_generation=lifecycle_generation+1 WHERE id=?',
      [pass.id],
    );
    expect(await authorized()).toEqual([0]);
  });

  it.each(['signed event', 'pending transfer', 'quarantine'] as const)(
    'gives no proof when the %s is not as it was signed',
    async (changed) => {
      const { pass, scanId, scope } = await lastScan();
      const proofOf = async () => {
        const plan = planHistoryProofSnapshotsForOrg(kit.ctx, scope, [scanId]);
        return (await plan.finish(await kit.env.DB.batch(plan.stmts))).has(scanId);
      };
      // Positive control: the same read proves the unchanged scan.
      expect(await proofOf()).toBe(true);
      if (changed === 'signed event')
        await run(
          kit.env.DB,
          "UPDATE pass_events SET data=json_set(data,'$.authority.role','manager') WHERE pass_id=? AND kind='scan.checked_in'",
          [pass.id],
        );
      else if (changed === 'pending transfer')
        await stagePendingCredentialTransfer(kit.env.DB, pass.id, {
          id: key(),
          token: key(),
          now: kit.clock.now(),
        });
      else await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined=1 WHERE id=?', [pass.id]);
      expect(await proofOf()).toBe(false);
    },
  );
});
