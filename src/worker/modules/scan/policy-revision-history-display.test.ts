import { beforeAll, describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { scannerActor, withRole } from './actor.ts';
import { scopeOf } from './card-projection.ts';
import { getScanner } from './repo-device.ts';
import { candidateById } from './repo-lookup.ts';
import { outputAuthorityPredicate } from './repo-output-authority.ts';
import { CHECK_IN, policyRevisionHelpers } from './repo-policy-revision-test-fixtures.ts';
import { readScannerScope } from './repo-scope.ts';
import { foundOf } from './resolve.ts';
import { isFinalizedDisplayHistory, prepareDisplayHistory } from './scan-display-history.ts';
import { proofedScanActor, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
const { scenario, requestOf } = policyRevisionHelpers(() => kit);
beforeAll(async () => {
  kit = await setupScanKit();
});

describe('scanner history event and source proofs', () => {
  it('finalizes display history only for the proven actor and exact pass snapshot', async () => {
    const s = await scenario();
    const result = (await (
      await kit.post(s.scanner.headers, '/actions', {
        ...requestOf(s.pass.id),
        actionId: 'auto',
      })
    ).json()) as { kind: string; scanId: string | null };
    expect(result.kind).toBe('ok');
    if (!result.scanId) throw new Error('Missing scan');
    const candidate = await candidateById(kit.env.DB, kit.org.id, s.pass.id);
    if (!candidate) throw new Error('Missing candidate');
    const found = await foundOf(kit.ctx, candidate, s.actor);
    if (!found) throw new Error('Missing authorized pass');
    const plan = await prepareDisplayHistory(kit.ctx, s.actor, found, {
      history: ['visits', 'scans'],
      ledger: [],
    });
    const now = kit.clock.now();
    const authority = outputAuthorityPredicate({
      actor: s.actor,
      event: s.actor.event,
      now,
      templateId: found.pass.templateId,
      pass: candidate.pass,
      connectionGeneration: candidate.connectionGeneration,
      activeTemplateVersion: candidate.activeTemplateVersion,
      orgRevision: candidate.orgRevision,
      templateRevision: candidate.templateRevision,
      release: candidate,
      displayTemplateVersion: candidate.displayTemplateVersion,
      checkInRules: candidate.checkInRules,
      lookupHash: candidate.lookupHash,
      requireActive: true,
      credentialTombstoneRefs: [],
      credentialKeysetCommitment: candidate.credentialKeysetCommitment,
    });
    const firstFence = plan.bind(now, authority);
    const history = firstFence.finalize(await kit.env.DB.batch(firstFence.stmts));
    expect(isFinalizedDisplayHistory(history, s.actor, found)).toBe(true);
    if (!history) throw new Error('Missing finalized history');
    expect(Object.isFrozen(history)).toBe(true);
    expect(Object.isFrozen(history.value)).toBe(true);
    expect(history.value).toMatchObject({
      visits: { total: 1 },
      scans: { total: 1 },
      lastScan: { label: 'Check in', action: 'Check in', where: s.actor.scanner?.name },
    });
    const displayInput = {
      actor: s.actor,
      pass: { id: found.pass.id, title: '' },
      screen: 'ready' as const,
      template: found,
      history,
    };
    expect(scopeOf(kit.ctx, displayInput, found).history).toMatchObject({ visits: { total: 1 } });
    expect(
      scopeOf(kit.ctx, { ...displayInput, history: { visits: { total: 99 } } }, found).history,
    ).not.toHaveProperty('visits');
    expect(
      scopeOf(kit.ctx, { ...displayInput, actor: { ...s.actor, role: 'door' } }, found).history,
    ).not.toHaveProperty('visits');
    const foreign = { ...found, pass: { ...found.pass, id: 'other' } };
    expect(
      scopeOf(kit.ctx, { ...displayInput, template: foreign }, foreign).history,
    ).not.toHaveProperty('visits');
    expect(isFinalizedDisplayHistory(history, { ...s.actor, role: 'door' }, found)).toBe(false);
    expect(
      isFinalizedDisplayHistory(history, s.actor, {
        ...found,
        pass: { ...found.pass, id: 'other' },
      }),
    ).toBe(false);
    const originalEvent = await first<{ id: string; data: string }>(
      kit.env.DB,
      "SELECT id,data FROM pass_events WHERE pass_id=? AND kind='scan.checked_in'",
      [s.pass.id],
    );
    if (!originalEvent) throw new Error('Missing event');
    await run(
      kit.env.DB,
      "UPDATE pass_events SET data=json_set(data,'$.authority.role','manager') WHERE pass_id=? AND kind='scan.checked_in'",
      [s.pass.id],
    );
    const changedFence = plan.bind(now, authority);
    const changed = changedFence.finalize(await kit.env.DB.batch(changedFence.stmts));
    expect(changed?.value).toMatchObject({ scans: { total: 1 } });
    expect(changed?.value).not.toHaveProperty('visits');
    expect(changed?.value).toMatchObject({ list: { scans: [] } });
    await run(kit.env.DB, 'UPDATE pass_events SET data=? WHERE id=?', [
      originalEvent.data,
      originalEvent.id,
    ]);
    await run(
      kit.env.DB,
      'UPDATE passes SET lifecycle_generation=lifecycle_generation+1 WHERE id=?',
      [s.pass.id],
    );
    const staleFence = plan.bind(now, authority);
    expect(staleFence.finalize(await kit.env.DB.batch(staleFence.stmts))).toBeNull();
    const refreshed = await candidateById(kit.env.DB, kit.org.id, s.pass.id);
    if (!refreshed) throw new Error('Missing restored candidate');
    const restored = await foundOf(kit.ctx, refreshed, s.actor);
    if (!restored) throw new Error('Missing restored pass');
    const restoredPlan = await prepareDisplayHistory(kit.ctx, s.actor, restored, {
      history: ['visits'],
      ledger: [],
    });
    const restoredAuthority = outputAuthorityPredicate({
      actor: s.actor,
      event: s.actor.event,
      now,
      templateId: restored.pass.templateId,
      pass: refreshed.pass,
      connectionGeneration: refreshed.connectionGeneration,
      activeTemplateVersion: refreshed.activeTemplateVersion,
      orgRevision: refreshed.orgRevision,
      templateRevision: refreshed.templateRevision,
      release: refreshed,
      displayTemplateVersion: refreshed.displayTemplateVersion,
      checkInRules: refreshed.checkInRules,
      lookupHash: refreshed.lookupHash,
      requireActive: true,
      credentialTombstoneRefs: [],
      credentialKeysetCommitment: refreshed.credentialKeysetCommitment,
    });
    const restoredFence = restoredPlan.bind(now, restoredAuthority);
    const restoredHistory = restoredFence.finalize(await kit.env.DB.batch(restoredFence.stmts));
    expect(restoredHistory?.value).toMatchObject({ visits: { total: 1 } });
  });

  it('retains proven display rows and generic totals when another history row is unproven', async () => {
    const templateId = await kit.scanTemplate('Mixed history proof', {
      actions: [{ ...CHECK_IN, repeat: 'always' }],
    });
    const pass = await kit.scanPass(templateId);
    const scanner = await kit.scanner({ templateIds: [templateId], settings: { lookup: true } });
    const firstResult = (await (
      await kit.post(scanner.headers, '/actions', {
        ...requestOf(pass.id),
        actionId: 'auto',
      })
    ).json()) as { kind: string; scanId: string | null };
    kit.clock.advance(1_000);
    const secondResult = (await (
      await kit.post(scanner.headers, '/actions', {
        ...requestOf(pass.id),
        actionId: 'auto',
      })
    ).json()) as { kind: string; scanId: string | null };
    expect(firstResult.kind).toBe('ok');
    expect(secondResult.kind).toBe('ok');
    if (!firstResult.scanId || !secondResult.scanId) throw new Error('Missing scans');
    await run(
      kit.env.DB,
      "UPDATE pass_events SET data=json_remove(data,'$.authority.eventProof') WHERE pass_id=? AND json_extract(data,'$.scanId')=?",
      [pass.id, firstResult.scanId],
    );
    const scannerRow = await getScanner(kit.env.DB, scanner.id);
    if (!scannerRow) throw new Error('Missing scanner');
    const actor = await proofedScanActor(
      kit.ctx,
      withRole(
        scannerActor(
          kit.ctx,
          scannerRow,
          scannerRow.mode,
          'cookie',
          await readScannerScope(kit.env.DB, scannerRow, null),
        ),
        null,
      ),
    );
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!candidate) throw new Error('Missing candidate');
    const found = await foundOf(kit.ctx, candidate, actor);
    if (!found) throw new Error('Missing authorized pass');
    const plan = await prepareDisplayHistory(kit.ctx, actor, found, {
      history: ['visits', 'scans'],
      ledger: [],
    });
    const now = kit.clock.now();
    const authority = outputAuthorityPredicate({
      actor,
      event: actor.event,
      now,
      templateId: found.pass.templateId,
      pass: candidate.pass,
      connectionGeneration: candidate.connectionGeneration,
      activeTemplateVersion: candidate.activeTemplateVersion,
      orgRevision: candidate.orgRevision,
      templateRevision: candidate.templateRevision,
      release: candidate,
      displayTemplateVersion: candidate.displayTemplateVersion,
      checkInRules: candidate.checkInRules,
      lookupHash: candidate.lookupHash,
      requireActive: true,
      credentialTombstoneRefs: [],
      credentialKeysetCommitment: candidate.credentialKeysetCommitment,
    });
    const bound = plan.bind(now, authority);
    const history = bound.finalize(await kit.env.DB.batch(bound.stmts));
    expect(history?.value).toMatchObject({
      scans: { total: 2 },
      list: { scans: [{ label: 'Check in' }] },
      lastScan: { label: 'Check in', action: 'Check in' },
    });
    expect(history?.value).not.toHaveProperty('visits');
    expect(history?.value).not.toHaveProperty('list.visits');
  });
});
