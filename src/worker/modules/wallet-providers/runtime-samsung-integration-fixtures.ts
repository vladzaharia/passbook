import { CompactSign, importPKCS8 } from 'jose';
import {
  credentialAad,
  decryptSecretText,
  type Envelope,
  encryptSecret,
  loadKekRing,
} from '../../platform/crypto.ts';
import { sha256Hex, toBase64 } from '../../platform/ids.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { newWalletClaimHandle, readWalletPassSnapshot, walletClaimHash } from './instance.ts';
import { setupWalletOfferKit } from './offers-test-fixtures.ts';
import { projectionPolicy } from './projection-contract.ts';
import { getApprovedProjection } from './projection-service.ts';
import { readHistoricalCredentialGeneration } from './repo-runtime-integration-fixtures.ts';
import { seedSamsungRetirementOperation } from './repo-runtime-samsung-integration-fixtures.ts';
import type { WalletRuntimeProviderResponse, WalletRuntimeScope } from './runtime.ts';
import {
  seedHistoricalProviderInstance,
  seedHistoricalSamsungRef,
} from './runtime-historical-fixtures.ts';
import { createSamsungRefId, type SamsungCardProjection } from './samsung.ts';

/** Seed an already-existing provider instance; no new offer or promotion is fabricated. */
export async function runtimeSamsungLegacyFixture(kind: 'refresh' | 'retirement', promoted = true) {
  const f = await setupWalletOfferKit({ google: 'absent', samsung: 'published' });
  const { kit, pass, samsung } = f;
  const credentialKeysetCommitment = f.credentialKeysetCommitment;
  if ((await requireCredentialRefKeyset(kit.env.DB, kit.env)) !== credentialKeysetCommitment)
    throw new Error('Historical Samsung fixture keyset changed');
  const snapshot = await readWalletPassSnapshot(kit.env.DB, {
    orgId: pass.orgId,
    mode: pass.mode,
    passId: pass.id,
    credentialKeysetCommitment,
  });
  if (!snapshot?.issuingReleaseId) throw new Error('Missing issued pass fixture');
  const generation = await readHistoricalCredentialGeneration(kit.env.DB, pass.id);
  if (
    !generation ||
    !Number.isSafeInteger(generation.credentialGeneration) ||
    generation.credentialGeneration < 1
  )
    throw new Error('Missing credential generation fixture');
  const approved = await getApprovedProjection(
    kit.ctx,
    {
      orgId: pass.orgId,
      mode: pass.mode,
      provider: 'samsung',
      templateId: snapshot.templateId,
      templateVersion: snapshot.templateVersion,
      appleReleaseId: snapshot.issuingReleaseId,
    },
    { credentialKeysetCommitment },
  );
  if (approved?.projection.provider !== 'samsung' || !f.samsungRelease?.candidateId)
    throw new Error('Missing verified Samsung release fixture');
  const scope: WalletRuntimeScope = {
    orgId: pass.orgId,
    mode: pass.mode,
    accountId: approved.release.accountId,
    credentialKeysetCommitment,
    accountRevision: approved.release.accountRevision,
    providerIdentityHash: approved.release.providerIdentityHash,
    providerReleaseId: approved.release.id,
  };
  const now = kit.clock.now();
  const instanceId = crypto.randomUUID();
  const initialOperationId = crypto.randomUUID();
  const operationId = kind === 'retirement' ? crypto.randomUUID() : initialOperationId;
  const version = kind === 'retirement' ? 2 : 1;
  const claimHandle = newWalletClaimHandle();
  const claimHash = await walletClaimHash(claimHandle);
  const policy = projectionPolicy('samsung');
  const refId = createSamsungRefId();
  const refHash = await sha256Hex(refId);
  const refRow = crypto.randomUUID();
  const refEnvelope = await encryptSecret(
    await loadKekRing(kit.env),
    refId,
    credentialAad(refRow, pass.orgId, `samsung-ref|${pass.mode}|${instanceId}`),
  );
  await seedHistoricalProviderInstance(kit.env.DB, {
    id: instanceId,
    passId: pass.id,
    orgId: pass.orgId,
    mode: pass.mode,
    provider: 'samsung',
    credentialGeneration: generation.credentialGeneration,
    credentialKeysetCommitment: scope.credentialKeysetCommitment,
    accountId: scope.accountId,
    releaseId: scope.providerReleaseId,
    operationId: initialOperationId,
    now,
    upsert: { requestHash: await sha256Hex(initialOperationId), state: 'succeeded' },
  });
  await seedHistoricalSamsungRef(kit.env.DB, {
    id: refRow,
    refHash,
    instanceId,
    credentialKeysetCommitment: scope.credentialKeysetCommitment,
    createdAt: now,
    initialExpiresAt: now + 300_000,
    promotedAt: promoted ? now : null,
    envelope: refEnvelope,
  });
  if (kind === 'retirement')
    await seedSamsungRetirementOperation(kit.env.DB, {
      operationId,
      instanceId,
      version,
      requestHash: await sha256Hex(operationId),
      snapshot,
      credentialGeneration: generation.credentialGeneration,
      scope,
      policy,
      claimHash,
      now,
    });
  const signingKey = (await importPKCS8(samsung.partnerPrivateKeyPem, 'RS256')) as CryptoKey;
  async function request(query = '') {
    const path = `/wallet/v1/samsung/cards/${samsung.cardId}/${refId}`;
    const token = await new CompactSign(
      new TextEncoder().encode(
        JSON.stringify({
          API: { method: 'GET', path: `${path}${query}` },
          refId,
        }),
      ),
    )
      .setProtectedHeader({
        alg: 'RS256',
        cty: 'AUTH',
        ver: '3',
        certificateId: samsung.certificateId,
        partnerId: samsung.partnerId,
        utc: kit.clock.now(),
      })
      .sign(signingKey);
    return new Request(`https://example.test${path}${query}`, {
      headers: { Authorization: `Bearer ${token}`, 'x-request-id': 'runtime-test' },
    });
  }
  const projection: SamsungCardProjection = {
    card: {
      type: 'loyalty',
      subType: 'others',
      data: [
        {
          refId,
          createdAt: now,
          updatedAt: now,
          state: 'ACTIVE',
          language: 'en',
          attributes: { title: 'Confidential member value' },
        },
      ],
    },
  };
  const responses: { id: string; envelope: Envelope }[] = [];
  async function onProviderResponse(response: WalletRuntimeProviderResponse) {
    const id = crypto.randomUUID();
    const envelope = await encryptSecret(
      await loadKekRing(kit.env),
      JSON.stringify({ ...response, body: toBase64(response.body) }),
      credentialAad(id, pass.orgId, 'runtime-test-outcome'),
    );
    responses.push({ id, envelope });
  }
  async function readResponses(): Promise<
    { stage: string; method: string; status: number; body: string }[]
  > {
    const ring = await loadKekRing(kit.env);
    return Promise.all(
      responses.map(async ({ id, envelope }) =>
        JSON.parse(
          await decryptSecretText(
            ring,
            envelope,
            credentialAad(id, pass.orgId, 'runtime-test-outcome'),
          ),
        ),
      ),
    );
  }
  return {
    ...f,
    snapshot,
    approved,
    scope,
    instanceId,
    operationId,
    version,
    claimHandle,
    refId,
    refHash,
    refRow,
    request,
    projection,
    responses,
    onProviderResponse,
    readResponses,
  };
}
