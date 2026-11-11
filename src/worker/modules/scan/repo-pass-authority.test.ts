import { beforeAll, describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { candidateById } from './repo-lookup.ts';
import { prepareActionPassFence } from './repo-pass-authority.ts';
import { passPredicate } from './repo-pass-predicates.ts';
import { personalizationFingerprint } from './scan-personalization-proof.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
beforeAll(async () => {
  kit = await setupScanKit();
});

describe('batched action pass authority', () => {
  it('binds the evaluated pass and completes its proof from the same batch row', async () => {
    const credentialKeysetCommitment = await ensureCredentialRefKeyset(kit.env.DB, kit.env);
    const template = await kit.scanTemplate('Batch pass fence', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const pass = await kit.scanPass(template);
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!candidate || candidate.walletVersion === null) throw new Error('Missing pass candidate');
    const evaluatedPass = structuredClone(candidate.pass);
    const originalGeneration = evaluatedPass.credentialGeneration;
    const originalPersonalization = JSON.stringify(evaluatedPass.personalization);
    const expectedHash = await personalizationFingerprint(
      kit.env,
      pass.orgId,
      pass.id,
      candidate.walletVersion,
      originalPersonalization,
    );
    const refs = ['a'.repeat(64)];
    const release = { ...candidate, credentialTombstoneRefs: refs, credentialKeysetCommitment };
    const keys = Object.fromEntries(
      Object.entries(kit.env).filter(([name]) => /^KEK_V\d+$/.test(name)),
    );
    expect(
      prepareActionPassFence(
        kit.env.DB,
        evaluatedPass,
        candidate.checkInRules,
        candidate.connectionGeneration,
        candidate.activeTemplateVersion,
        candidate.orgRevision,
        candidate.templateRevision,
        kit.clock.now(),
        keys,
        { ...release, credentialTombstoneRefs: ['bad'] },
      ),
    ).toBeNull();
    expect(
      prepareActionPassFence(
        kit.env.DB,
        evaluatedPass,
        candidate.checkInRules,
        candidate.connectionGeneration,
        candidate.activeTemplateVersion,
        candidate.orgRevision,
        candidate.templateRevision,
        kit.clock.now(),
        keys,
        { ...release, credentialKeysetCommitment: 'bad' },
      ),
    ).toBeNull();
    const plan = prepareActionPassFence(
      kit.env.DB,
      evaluatedPass,
      candidate.checkInRules,
      candidate.connectionGeneration,
      candidate.activeTemplateVersion,
      candidate.orgRevision,
      candidate.templateRevision,
      kit.clock.now(),
      keys,
      release,
    );
    if (!plan) throw new Error('Expected a prepared pass fence');
    refs[0] = 'b'.repeat(64);
    evaluatedPass.credentialGeneration += 1;
    evaluatedPass.personalization.memberName = 'changed after preparation';
    release.activeReleaseId = 'changed-release';
    release.credentialKeysetCommitment = '0'.repeat(64);
    for (const name of Object.keys(keys)) keys[name] = btoa('z'.repeat(32));
    expect(await plan.keysetCurrent).toBe(true);
    const results = await kit.env.DB.batch([plan.statement]);
    const row = results[0]?.results?.[0] as { rules: string | null } | undefined;
    const fence = await plan.complete(row);
    expect(fence).toMatchObject({
      credentialGeneration: originalGeneration,
      credentialTombstoneRefs: ['a'.repeat(64)],
      credentialKeysetCommitment,
      evaluatedPersonalizationHash: expectedHash,
      transferPending: false,
      noPendingTransfer: true,
      walletStatus: 'active',
    });
    expect(Object.isFrozen(fence?.credentialTombstoneRefs)).toBe(true);
    expect(
      passPredicate({ ...pass, imageGeneration: -1 }, candidate.connectionGeneration).sql,
    ).toBe('0');
    await run(kit.env.DB, 'UPDATE passes SET image_generation=image_generation+1 WHERE id=?', [
      pass.id,
    ]);
    expect(
      await first(kit.env.DB, `SELECT 1 FROM passes p WHERE ${plan.guard.sql}`, plan.guard.params),
    ).toBeNull();
    const identityOnly = passPredicate(candidate.pass, candidate.connectionGeneration, {
      imagePolicy: 'identity-only',
    });
    expect(
      await first(
        kit.env.DB,
        `SELECT 1 FROM passes p WHERE ${identityOnly.sql}`,
        identityOnly.params,
      ),
    ).not.toBeNull();
    expect(
      passPredicate({ ...candidate.pass, imageGeneration: -1 }, candidate.connectionGeneration, {
        imagePolicy: 'identity-only',
      }).sql,
    ).toBe('0');
    expect(await plan.complete(undefined)).toBeNull();
  });
});
