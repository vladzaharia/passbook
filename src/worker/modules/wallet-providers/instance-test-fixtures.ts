import { sha256Hex } from '../../platform/ids.ts';
import {
  readWalletPassSnapshot,
  type WalletInstanceProof,
  type WalletOperation,
} from './instance.ts';
import { setupWalletOfferKit } from './offers-test-fixtures.ts';
import { projectionPolicy } from './projection-contract.ts';
import { getApprovedProjection } from './projection-service.ts';
import { seedHistoricalProviderInstance } from './runtime-historical-fixtures.ts';

export async function fixture() {
  const f = await setupWalletOfferKit({ google: 'absent' });
  const scope = {
    orgId: f.pass.orgId,
    mode: f.pass.mode,
    provider: 'samsung' as const,
    credentialKeysetCommitment: f.credentialKeysetCommitment,
  };
  const snapshot = await readWalletPassSnapshot(f.kit.env.DB, { ...scope, passId: f.pass.id });
  if (!snapshot?.issuingReleaseId) throw new Error('Missing issuing release');
  const approved = await getApprovedProjection(f.kit.ctx, {
    ...scope,
    templateId: snapshot.templateId,
    templateVersion: snapshot.templateVersion,
    appleReleaseId: snapshot.issuingReleaseId,
  });
  if (!approved) throw new Error('Missing reviewed native projection');
  const policy = projectionPolicy(scope.provider);
  const proof: WalletInstanceProof = {
    ...scope,
    passId: f.pass.id,
    passVersion: snapshot.passVersion,
    passRevision: snapshot.passRevision,
    passCredentialGeneration: snapshot.credentialGeneration,
    lifecycleGeneration: snapshot.lifecycleGeneration,
    issuingReleaseId: snapshot.issuingReleaseId,
    projectionReleaseId: approved.release.id,
    accountId: approved.release.accountId,
    accountRevision: approved.release.accountRevision,
    adapterRevision: policy.adapterRevision,
    policyRevision: policy.audiencePolicyRevision,
  };
  async function current(): Promise<WalletInstanceProof> {
    const pass = await readWalletPassSnapshot(f.kit.env.DB, { ...scope, passId: f.pass.id });
    if (!pass) throw new Error('Pass disappeared');
    return {
      ...proof,
      passVersion: pass.passVersion,
      passRevision: pass.passRevision,
      passCredentialGeneration: pass.credentialGeneration,
      lifecycleGeneration: pass.lifecycleGeneration,
      issuingReleaseId: pass.issuingReleaseId,
    };
  }
  async function create(target: WalletInstanceProof = proof) {
    const operationId = crypto.randomUUID();
    const operation = await seedHistoricalProviderInstance(f.kit.env.DB, {
      id: crypto.randomUUID(),
      operationId,
      passId: target.passId,
      orgId: target.orgId,
      mode: target.mode,
      provider: target.provider,
      credentialGeneration: target.passCredentialGeneration,
      credentialKeysetCommitment: f.credentialKeysetCommitment,
      accountId: target.accountId,
      releaseId: target.projectionReleaseId,
      now: f.kit.clock.now(),
      upsert: { requestHash: await sha256Hex(operationId), state: 'pending' },
    });
    if (!operation) throw new Error('Historical operation missing');
    return operation;
  }
  return { ...f, scope, proof, current, create };
}

export const reference = (op: WalletOperation) => ({
  orgId: op.orgId,
  mode: op.mode,
  provider: op.provider,
  instanceId: op.instanceId,
  version: op.version,
});
