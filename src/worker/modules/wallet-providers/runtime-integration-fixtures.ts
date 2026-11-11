import type { SessionAuth } from '../../platform/auth.ts';
import { credentialAad, type Envelope, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { sha256Hex, toBase64 } from '../../platform/ids.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import type { Kit } from '../passes/pass-test-fixtures.ts';
import { readGoogleCallbackVerification } from './account-service.ts';
import { newWalletClaimHandle, readWalletPassSnapshot, walletClaimHash } from './instance.ts';
import { setupWalletOfferKit } from './offers-test-fixtures.ts';
import { projectionPolicy, providerIdentityHash } from './projection-contract.ts';
import { approveProjectionCandidate, createProjectionCandidate } from './projection-service.ts';
import {
  insertHistoricalGoogleRelease,
  insertHistoricalGoogleRevoke,
  markHistoricalGoogleRevoking,
  readHistoricalCredentialGeneration,
  readHistoricalGoogleAccount,
  readHistoricalGoogleReleaseGuard,
} from './repo-runtime-integration-fixtures.ts';
import type { WalletRuntimeProviderResponse, WalletRuntimeScope } from './runtime.ts';
import { seedHistoricalProviderInstance } from './runtime-historical-fixtures.ts';

export { runtimeSamsungLegacyFixture } from './runtime-samsung-integration-fixtures.ts';

export interface HistoricalGoogleFixture {
  kit: Kit;
  apple: { id: string; authorAuth: SessionAuth; reviewerAuth: SessionAuth };
  credentialKeysetCommitment: string;
  pass: { orgId: string; mode: 'live' | 'test' };
  projection(provider: 'google'): unknown;
}

/**
 * Model a pre-gate Google release in the isolated test database. Its candidate and independent
 * review are real; no present-day publisher/replay evidence is asserted. Restore the exact
 * release trigger in the same D1 transaction, so this fixture never enables public issuance.
 */
export async function historicalGoogleRelease(f: HistoricalGoogleFixture): Promise<string> {
  const { kit, apple, pass } = f;
  const scope = { orgId: pass.orgId, mode: pass.mode, provider: 'google' as const };
  const candidate = await createProjectionCandidate(kit.ctx, apple.authorAuth, kit.template.id, {
    ...scope,
    version: kit.template.version,
    sourceReleaseId: apple.id,
    projection: f.projection('google'),
  });
  const approval = await approveProjectionCandidate(
    kit.ctx,
    apple.reviewerAuth,
    kit.template.id,
    candidate.id,
    {
      ...scope,
      candidateHash: candidate.candidateHash,
    },
  );
  const trigger = await readHistoricalGoogleReleaseGuard(kit.env.DB);
  if (!trigger?.sql) throw new Error('Missing native release guard');
  const releaseId = kit.ctx.ids.id();
  const results = await insertHistoricalGoogleRelease(kit.env.DB, {
    triggerSql: trigger.sql,
    releaseId,
    now: kit.clock.now(),
    candidateId: candidate.id,
    approvalId: approval.id,
    credentialKeysetCommitment: f.credentialKeysetCommitment,
  });
  if (results[1]?.meta.changes !== 1) throw new Error('Missing historical Google release');
  return releaseId;
}

/** An authenticated historical Google revoke, never a new issuance authorization. */
export async function runtimeGoogleLegacyFixture(options: { db?: D1Database } = {}) {
  const f = await setupWalletOfferKit({
    google: 'configured',
    samsung: 'absent',
    db: options.db,
  });
  const { kit, pass, google } = f;
  const credentialKeysetCommitment = f.credentialKeysetCommitment;
  if ((await requireCredentialRefKeyset(kit.env.DB, kit.env)) !== credentialKeysetCommitment)
    throw new Error('Historical Google fixture keyset changed');
  const releaseId = await historicalGoogleRelease(f);
  const snapshot = await readWalletPassSnapshot(kit.env.DB, {
    orgId: pass.orgId,
    mode: pass.mode,
    passId: pass.id,
    credentialKeysetCommitment,
  });
  const account = await readHistoricalGoogleAccount(kit.env.DB, pass.orgId, pass.mode);
  if (!snapshot?.issuingReleaseId || !account) throw new Error('Missing historical Google fixture');
  const verification = await readGoogleCallbackVerification(kit.ctx, {
    orgId: pass.orgId,
    mode: pass.mode,
    accountId: account.id,
    accountRevision: account.revision,
    credentialKeysetCommitment,
  });
  if (!verification) throw new Error('Missing Google verification fixture');
  const generation = await readHistoricalCredentialGeneration(kit.env.DB, pass.id);
  if (
    !generation ||
    !Number.isSafeInteger(generation.credentialGeneration) ||
    generation.credentialGeneration < 1
  )
    throw new Error('Missing credential generation fixture');
  const scope: WalletRuntimeScope = {
    orgId: pass.orgId,
    mode: pass.mode,
    accountId: account.id,
    accountRevision: account.revision,
    credentialKeysetCommitment,
    providerIdentityHash: await providerIdentityHash({ provider: 'google', credentials: google }),
    providerReleaseId: releaseId,
  };
  const now = kit.clock.now();
  const instanceId = kit.ctx.ids.id();
  const operationId = kit.ctx.ids.id();
  const claimHandle = newWalletClaimHandle();
  const policy = projectionPolicy('google');
  await seedHistoricalProviderInstance(kit.env.DB, {
    id: instanceId,
    passId: pass.id,
    orgId: pass.orgId,
    mode: pass.mode,
    provider: 'google',
    credentialGeneration: generation.credentialGeneration,
    credentialKeysetCommitment: scope.credentialKeysetCommitment,
    accountId: account.id,
    releaseId,
    operationId,
    retirementRequestedAt: now,
    now,
  });
  await insertHistoricalGoogleRevoke(kit.env.DB, {
    operationId,
    instanceId,
    requestHash: await sha256Hex(operationId),
    passVersion: snapshot.passVersion,
    passRevision: snapshot.passRevision,
    credentialGeneration: generation.credentialGeneration,
    lifecycleGeneration: snapshot.lifecycleGeneration,
    issuingReleaseId: snapshot.issuingReleaseId,
    releaseId,
    accountRevision: scope.accountRevision,
    adapterRevision: policy.adapterRevision,
    policyRevision: policy.audiencePolicyRevision,
    credentialKeysetCommitment: scope.credentialKeysetCommitment,
    claimHash: await walletClaimHash(claimHandle),
    now,
  });
  await markHistoricalGoogleRevoking(kit.env.DB, instanceId);
  const responses: Envelope[] = [];
  async function onProviderResponse(response: WalletRuntimeProviderResponse) {
    responses.push(
      await encryptSecret(
        await loadKekRing(kit.env),
        JSON.stringify({
          ...response,
          body: toBase64(response.body),
        }),
        credentialAad(instanceId, pass.orgId, 'runtime-google-test-outcome'),
      ),
    );
  }
  return {
    ...f,
    snapshot,
    scope,
    verification,
    releaseId,
    instanceId,
    operationId,
    claimHandle,
    credentialGeneration: generation.credentialGeneration,
    responses,
    onProviderResponse,
  };
}
