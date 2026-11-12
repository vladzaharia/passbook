import { beforeAll, describe, expect, it, vi } from 'vitest';
import { first } from '../../platform/db.ts';
import { credentialRefKeysetCommitment } from '../passes/credential-keyset.ts';
import { scannerActor, withRole } from './actor.ts';
import { cardLastScansSplitFixture } from './card-last-scans-split-fixture.ts';
import { getScanner } from './repo-device.ts';
import { candidateById } from './repo-lookup.ts';
import { outputAuthorityPredicate } from './repo-output-authority.ts';
import { readScannerScope } from './repo-scope.ts';
import { foundOf } from './resolve.ts';
import { isFinalizedDisplayHistory, prepareDisplayHistory } from './scan-display-history.ts';
import {
  proofedScanActor,
  type ScanKit,
  setupScanKit,
  startScanCredentialTransfer,
} from './test-kit.ts';

let kit: ScanKit;

beforeAll(async () => {
  kit = await setupScanKit();
});

const { act, body, card, last, simple } = cardLastScansSplitFixture(() => kit);

describe('card last-scan privacy', () => {
  it('binds finalized card history to the actor and pass keyset snapshots', async () => {
    const { pass, scanner } = await simple();
    const scannerRow = await getScanner(kit.env.DB, scanner.id);
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!scannerRow || !candidate) throw new Error('Missing real card fixture');
    const scope = await readScannerScope(kit.env.DB, scannerRow, null);
    const actor = withRole(
      await proofedScanActor(kit.ctx, scannerActor(kit.ctx, scannerRow, 'live', 'cookie', scope)),
      null,
    );
    const found = await foundOf(kit.ctx, candidate, actor);
    if (!found) throw new Error('Missing evaluated card fixture');
    const original = found.credentialKeysetCommitment;
    const other = await credentialRefKeysetCommitment({ KEK_V1: btoa('a'.repeat(32)) });
    expect(other).not.toBe(original);
    const now = kit.clock.now();
    const authority = outputAuthorityPredicate({
      actor,
      event: found.admission?.event ?? actor.event,
      now,
      credentialTombstoneRefs: found.credentialTombstoneRefs,
      credentialKeysetCommitment: original,
      templateId: found.pass.templateId,
      pass: found.liveCandidate?.pass ?? found.pass,
      connectionGeneration: found.connectionGeneration,
      activeTemplateVersion: found.activeVersion,
      orgRevision: found.orgRevision,
      templateRevision: found.templateRevision,
      release: found,
      displayTemplateVersion: found.displayTemplateVersion,
      checkInRules: found.checkInRules,
      lookupHash: found.liveCandidate?.lookupHash,
      requireActive: true,
    });
    const needs = { history: [], ledger: [] };
    const plan = await prepareDisplayHistory(kit.ctx, actor, found, needs);
    const initial = plan.bind(now, authority);
    const history = initial.finalize(await kit.env.DB.batch(initial.stmts));
    expect(isFinalizedDisplayHistory(history, actor, found)).toBe(true);
    actor.credentialKeysetCommitment = other;
    expect(isFinalizedDisplayHistory(history, actor, found)).toBe(false);
    actor.credentialKeysetCommitment = original;

    const raced = plan.bind(now, authority);
    const captured = await kit.env.DB.batch(raced.stmts);
    actor.credentialKeysetCommitment = other;
    expect(raced.finalize(captured)).toBeNull();
    const mismatched = await prepareDisplayHistory(kit.ctx, actor, found, needs);
    const mismatchedBound = mismatched.bind(now, authority);
    expect(mismatchedBound.finalize(await kit.env.DB.batch(mismatchedBound.stmts))).toBeNull();

    const missingActor = { ...actor, credentialKeysetCommitment: '' };
    const missingFound = { ...found, credentialKeysetCommitment: '' };
    const missing = await prepareDisplayHistory(kit.ctx, missingActor, missingFound, needs);
    const missingBound = missing.bind(now, authority);
    expect(missingBound.finalize(await kit.env.DB.batch(missingBound.stmts))).toBeNull();
  });

  it('omits a prior-credential scan after a real transfer completes', async () => {
    const { pass, scanner } = await simple();
    const scanId = await act(scanner.headers, pass.id);
    expect(last(await card(scanner.headers, pass.id), scanId).actionLabel).toBe('Admit member');
    expect(
      await startScanCredentialTransfer(kit, pass.id, {
        target: { holderEmail: 'incoming@example.test', ownerUserId: null },
      }),
    ).toMatchObject({ state: 'completed' });
    expect(
      (await card(scanner.headers, pass.id)).lastScans.find((row) => row.scanId === scanId),
    ).toBeUndefined();
  });

  it('does not disclose pass history while a credential transfer is pending', async () => {
    const { pass, scanner } = await simple();
    const scanId = await act(scanner.headers, pass.id);
    // A publication failure leaves the real, durably reserved transfer pending.
    const put = vi
      .spyOn(kit.env.BUCKET, 'put')
      .mockRejectedValueOnce(new Error('Publication unavailable'));
    try {
      const transfer = await startScanCredentialTransfer(kit, pass.id, {
        target: { holderEmail: 'incoming@example.test', ownerUserId: null },
      });
      expect(transfer).toMatchObject({ state: 'pending' });
      expect(
        await first(
          kit.env.DB,
          `SELECT state,source_generation,target_generation
        FROM pass_credential_transfers WHERE id=?`,
          [transfer.transferId],
        ),
      ).toEqual({
        state: 'pending',
        source_generation: pass.credentialGeneration,
        target_generation: pass.credentialGeneration + 1,
      });
      expect(
        await first(kit.env.DB, 'SELECT credential_generation FROM passes WHERE id=?', [pass.id]),
      ).toEqual({ credential_generation: pass.credentialGeneration + 1 });
    } finally {
      put.mockRestore();
    }
    const response = await kit.post(scanner.headers, '/resolve', body(pass.id));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ kind: 'refused', reason: 'not_found', card: null });
    for (const secret of [pass.id, scanId, 'Admit member']) expect(text).not.toContain(secret);
  });
});
