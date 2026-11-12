import { describe, expect, it, onTestFinished } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { credentialAad, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { all, first, run } from '../../platform/db.ts';
import { randomBytes, sha256Hex, toBase64Url } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { credentialRefKeysetCommitment } from '../passes/credential-keyset.ts';
import {
  finishCredentialTransfer,
  startCredentialTransfer,
} from '../passes/credential-transfer.ts';
import { deletePassRows, expiredDeletedPasses } from '../passes/repo-ops-retention.ts';
import { getPassBySerial } from '../passes/repo-read-pass.ts';
import { prepareScanRetentionDelete } from '../scan/scan-retention-proof.ts';
import {
  ensureSamsungFetchRef,
  inspectSamsungRefRetirement,
  retireExpiredUnpromotedRef,
} from './callbacks-ref.ts';
import {
  claimWalletOperation,
  completeWalletOperation,
  consumeWalletOfferRef,
  createWalletInstance,
  createWalletInstanceAndOffer,
  createWalletOfferRef,
  getWalletInstance,
  getWalletInstanceById,
  getWalletOperation,
  listDirtyWalletInstances,
  markWalletClaimUncertain,
  newWalletClaimHandle,
  queueWalletOperation,
  readWalletPassSnapshot,
  recordWalletOperationOutcome,
  requestWalletRetirement,
  retireWalletInstance,
  settleWalletClaim,
  type WalletInstanceProof,
  type WalletOperation,
  walletOfferFresh,
  walletOperationFresh,
} from './instance.ts';
import { setupWalletOfferKit } from './offers-test-fixtures.ts';
import { projectionPolicy } from './projection-contract.ts';
import { getApprovedProjection } from './projection-service.ts';
import { setWalletProvidersEnabledForTest, whileDisabledForTest } from './provider-policy.ts';
import { googleRetirementTargetSql } from './repo-accounts.ts';
import { consumeOffer, readOffer } from './repo-instance-offers.ts';
import {
  seedHistoricalSamsungRef as insertHistoricalSamsungRef,
  seedHistoricalOfferRef,
  seedHistoricalProviderInstance,
} from './runtime-historical-fixtures.ts';
import { historicalGoogleRelease } from './runtime-integration-fixtures.ts';

async function fixture() {
  const f = await setupWalletOfferKit({ google: 'absent' });
  const scope = {
    orgId: f.pass.orgId,
    mode: f.pass.mode,
    provider: 'samsung' as const,
    credentialKeysetCommitment: f.credentialKeysetCommitment,
  };
  const snapshot = await readWalletPassSnapshot(f.kit.env.DB, { ...scope, passId: f.pass.id });
  if (!snapshot?.issuingReleaseId) throw new Error('Missing issuing release');
  const approved = await getApprovedProjection(
    f.kit.ctx,
    {
      ...scope,
      templateId: snapshot.templateId,
      templateVersion: snapshot.templateVersion,
      appleReleaseId: snapshot.issuingReleaseId,
    },
    { credentialKeysetCommitment: f.credentialKeysetCommitment },
  );
  if (!approved) throw new Error('Missing reviewed native projection');
  const policy = projectionPolicy(scope.provider);
  const proof: WalletInstanceProof = {
    ...scope,
    passId: f.pass.id,
    passVersion: snapshot.passVersion,
    passRevision: snapshot.passRevision,
    passCredentialGeneration: snapshot.credentialGeneration,
    lifecycleGeneration: snapshot.lifecycleGeneration,
    credentialKeysetCommitment: f.credentialKeysetCommitment,
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
      credentialKeysetCommitment: target.credentialKeysetCommitment,
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

const reference = (op: WalletOperation) => ({
  orgId: op.orgId,
  mode: op.mode,
  provider: op.provider,
  instanceId: op.instanceId,
  version: op.version,
  credentialKeysetCommitment: op.credentialKeysetCommitment,
});

async function seedHistoricalOffer(
  db: D1Database,
  op: WalletOperation,
  now: number,
  expiresAt: number,
): Promise<string> {
  const ref = toBase64Url(randomBytes(32));
  await seedHistoricalOfferRef(db, {
    refHash: await sha256Hex(ref),
    instanceId: op.instanceId,
    operationVersion: op.version,
    createdAt: now,
    expiresAt,
    consumedAt: null,
    deliveredAt: null,
  });
  return ref;
}

async function seedHistoricalSamsungRef(
  ctx: ServiceContext,
  op: WalletOperation,
  now: number,
  expiresAt: number,
  promoted: boolean,
): Promise<string> {
  const id = crypto.randomUUID();
  const ref = toBase64Url(randomBytes(24));
  const envelope = await encryptSecret(
    await loadKekRing(ctx.env),
    ref,
    credentialAad(id, op.orgId, `samsung-ref|${op.mode}|${op.instanceId}`),
  );
  await insertHistoricalSamsungRef(ctx.env.DB, {
    id,
    refHash: await sha256Hex(ref),
    instanceId: op.instanceId,
    credentialKeysetCommitment: op.credentialKeysetCommitment,
    createdAt: now,
    initialExpiresAt: expiresAt,
    promotedAt: promoted ? now : null,
    envelope,
  });
  return ref;
}

describe('native wallet instance lifecycle', () => {
  it('denies new issuance despite native approval and fences historical operations against stale proofs', async () => {
    const f = await fixture();
    const db = f.kit.env.DB;
    const other = await makeOrg(f.kit.fx);
    const attempts: WalletInstanceProof[] = [
      { ...f.proof, orgId: other.id },
      { ...f.proof, mode: 'test' },
      { ...f.proof, passVersion: f.proof.passVersion + 1 },
      { ...f.proof, passRevision: f.proof.passRevision + 1 },
      { ...f.proof, passCredentialGeneration: f.proof.passCredentialGeneration + 1 },
      { ...f.proof, lifecycleGeneration: f.proof.lifecycleGeneration + 1 },
      { ...f.proof, accountRevision: f.proof.accountRevision + 1 },
      { ...f.proof, issuingReleaseId: null },
      { ...f.proof, projectionReleaseId: f.apple.id },
      { ...f.proof, adapterRevision: f.proof.adapterRevision + 1 },
      { ...f.proof, policyRevision: f.proof.policyRevision + 1 },
    ];
    for (const proof of attempts) {
      expect(
        await whileDisabledForTest(createWalletInstance, db, {
          ...proof,
          instanceId: crypto.randomUUID(),
          requestKey: crypto.randomUUID(),
          newId: () => crypto.randomUUID(),
          now: f.kit.clock.now(),
        }),
      ).toBeNull();
    }
    expect(
      await all(db, 'SELECT id FROM wallet_provider_instances WHERE pass_id = ?', [f.pass.id]),
    ).toEqual([]);
    const p = {
      ...f.proof,
      instanceId: crypto.randomUUID(),
      requestKey: crypto.randomUUID(),
      newId: () => crypto.randomUUID(),
      now: f.kit.clock.now(),
    };
    // An independently reviewed projection does not establish recipient-market or publishing proof.
    expect(await whileDisabledForTest(createWalletInstance, db, p)).toBeNull();
    expect(
      await all(db, 'SELECT id FROM wallet_provider_instances WHERE pass_id = ?', [f.pass.id]),
    ).toEqual([]);
    const created = await f.create();
    expect(created).toMatchObject({
      version: 1,
      state: 'pending',
      identityProjectionReleaseId: f.proof.projectionReleaseId,
    });
    expect(await whileDisabledForTest(createWalletInstance, db, p)).toBeNull();
    expect(
      await whileDisabledForTest(createWalletInstance, db, {
        ...p,
        instanceId: created.instanceId,
      }),
    ).toBeNull();
    expect(await getWalletInstance(db, { ...f.scope, passId: f.pass.id })).toMatchObject({
      installationState: 'unknown',
      installationObservedAt: null,
      lifecycle: 'active',
      desiredVersion: 1,
    });
    expect(
      await getWalletInstance(db, { ...f.scope, orgId: other.id, passId: f.pass.id }),
    ).toBeNull();
    for (const proof of attempts) {
      expect(
        await queueWalletOperation(db, {
          ...proof,
          instanceId: created.instanceId,
          expectedVersion: created.version,
          kind: 'upsert',
          requestKey: crypto.randomUUID(),
          newId: () => crypto.randomUUID(),
          now: p.now,
        }),
      ).toBeNull();
    }
    expect(await getWalletInstance(db, { ...f.scope, passId: f.pass.id })).toMatchObject({
      desiredVersion: created.version,
    });
    const next = await queueWalletOperation(db, {
      ...f.proof,
      instanceId: created.instanceId,
      expectedVersion: created.version,
      kind: 'upsert',
      requestKey: crypto.randomUUID(),
      newId: () => crypto.randomUUID(),
      now: p.now,
    });
    expect(next).toMatchObject({
      instanceId: created.instanceId,
      version: created.version + 1,
      state: 'pending',
    });
    expect(await getWalletOperation(db, reference(created))).toMatchObject({ state: 'superseded' });
  });

  it('holds claims and empty-reference retirement under the original keyset', async () => {
    const f = await fixture();
    const db = f.kit.env.DB;
    const op = await f.create();
    const now = f.kit.clock.now();
    const wrongEnv = { ...f.kit.env, KEK_V1: btoa('z'.repeat(32)) };
    const wrongCommitment = await credentialRefKeysetCommitment(wrongEnv);
    expect(wrongCommitment).not.toBe(op.credentialKeysetCommitment);
    const claim = { ...reference(op), claimHandle: newWalletClaimHandle(), now };
    const wrong = { ...claim, credentialKeysetCommitment: wrongCommitment };
    expect(
      await readWalletPassSnapshot(db, {
        ...f.scope,
        passId: f.pass.id,
        credentialKeysetCommitment: wrongCommitment,
      }),
    ).toBeNull();
    expect(
      await claimWalletOperation(db, {
        ...claim,
        credentialKeysetCommitment: undefined as unknown as string,
      }),
    ).toBe('not_claimable');
    for (const malformed of [
      `${op.credentialKeysetCommitment}\n`,
      `${op.credentialKeysetCommitment}\0`,
      'A'.repeat(64),
      op.credentialKeysetCommitment.slice(1),
      new Uint8Array(64) as unknown as string,
    ]) {
      expect(
        await claimWalletOperation(db, { ...claim, credentialKeysetCommitment: malformed }),
      ).toBe('not_claimable');
    }
    expect(await claimWalletOperation(db, wrong)).toBe('not_claimable');
    expect(
      await queueWalletOperation(db, {
        ...f.proof,
        credentialKeysetCommitment: wrongCommitment,
        instanceId: op.instanceId,
        expectedVersion: op.version,
        kind: 'revoke',
        requestKey: crypto.randomUUID(),
        newId: () => crypto.randomUUID(),
        now,
      }),
    ).toBeNull();
    expect(await claimWalletOperation(db, claim)).toBe('claimed');
    expect(await walletOperationFresh(db, wrong)).toBe(false);
    expect(await markWalletClaimUncertain(db, wrong)).toBe(false);
    expect(await settleWalletClaim(db, wrong)).toBe(false);
    expect(
      await recordWalletOperationOutcome(f.kit.ctx, {
        ...wrong,
        sequence: 1,
        eventKey: 'response',
        body: new Uint8Array([1]),
        reason: 'ok',
      }),
    ).toBe('stale');
    expect(
      await completeWalletOperation(f.kit.ctx, { ...wrong, result: { kind: 'success' } }),
    ).toBeNull();
    await expect(
      completeWalletOperation(
        { ...f.kit.ctx, env: wrongEnv },
        {
          ...claim,
          result: { kind: 'success' },
        },
      ),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE' });
    expect(await getWalletOperation(db, reference(op))).toMatchObject({
      state: 'claimed',
      attempts: 1,
    });
    expect(
      await completeWalletOperation(f.kit.ctx, { ...claim, result: { kind: 'success' } }),
    ).toBe('succeeded');

    expect(
      await requestWalletRetirement(db, { ...reference(op), ...(await f.current()), now }),
    ).toBe(true);
    const revoke = await queueWalletOperation(db, {
      ...(await f.current()),
      instanceId: op.instanceId,
      expectedVersion: op.version,
      kind: 'revoke',
      requestKey: crypto.randomUUID(),
      newId: () => crypto.randomUUID(),
      now,
    });
    if (!revoke) throw new Error('Retirement revoke not queued');
    const revokeClaim = { ...reference(revoke), claimHandle: newWalletClaimHandle(), now };
    expect(await claimWalletOperation(db, revokeClaim)).toBe('claimed');
    expect(
      await completeWalletOperation(f.kit.ctx, { ...revokeClaim, result: { kind: 'success' } }),
    ).toBe('succeeded');
    expect(
      await retireWalletInstance(db, {
        ...revokeClaim,
        credentialKeysetCommitment: wrongCommitment,
      }),
    ).toBe(false);
    expect(await getWalletInstanceById(db, reference(op))).toMatchObject({ lifecycle: 'revoked' });
    expect(await retireWalletInstance(db, revokeClaim)).toBe(true);
  });

  it('denies Google issuance and offers even with a historically reviewed projection', async () => {
    const f = await fixture();
    const db = f.kit.env.DB;
    await f.configure('google');
    const account = await first<{ id: string; revision: number }>(
      db,
      "SELECT id, revision FROM wallet_provider_accounts WHERE org_id = ? AND mode = ? AND provider = 'google'",
      [f.pass.orgId, f.pass.mode],
    );
    if (!account) throw new Error('Missing Google fixture account');
    const releaseId = await historicalGoogleRelease(f);
    const policy = projectionPolicy('google');
    const proof = {
      ...f.proof,
      provider: 'google' as const,
      accountId: account.id,
      accountRevision: account.revision,
      projectionReleaseId: releaseId,
      adapterRevision: policy.adapterRevision,
      policyRevision: policy.audiencePolicyRevision,
    };
    const now = f.kit.clock.now();
    const authority = { kind: 'download' as const, token: f.pass.downloadToken };
    const input = {
      ...proof,
      instanceId: crypto.randomUUID(),
      requestKey: crypto.randomUUID(),
      newId: () => crypto.randomUUID(),
      now,
    };
    expect(await whileDisabledForTest(createWalletInstance, db, input)).toBeNull();
    expect(await createWalletInstanceAndOffer(db, { ...input, authority })).toBeNull();
    expect(
      await first(
        db,
        "SELECT id FROM wallet_provider_instances WHERE pass_id = ? AND provider = 'google'",
        [f.pass.id],
      ),
    ).toBeNull();
    const operation = await f.create(proof);
    expect(await createWalletInstanceAndOffer(db, { ...input, authority })).toBeNull();
    expect(await createWalletOfferRef(db, { ...reference(operation), now, authority })).toBeNull();
    expect(
      await all(db, 'SELECT ref_hash FROM wallet_provider_offer_refs WHERE instance_id = ?', [
        operation.instanceId,
      ]),
    ).toEqual([]);
  });

  it('pins the Google retirement target predicate to the exact instance generation', async () => {
    // The predicate is provider-independent; use a real Samsung instance rather than fabricate
    // Google publishing approval to exercise its D1 generation and identity bindings.
    const f = await fixture();
    const op = await f.create();
    const sql = `SELECT 1 AS ok FROM wallet_provider_instances i WHERE i.id = ? AND ${googleRetirementTargetSql}`;
    const values = [
      op.instanceId,
      op.passId,
      op.identityProjectionReleaseId,
      op.credentialGeneration,
    ] as const;
    expect(await first(f.kit.env.DB, sql, values)).toEqual({ ok: 1 });
    expect(
      await first(f.kit.env.DB, sql, [
        op.instanceId,
        op.passId,
        op.identityProjectionReleaseId,
        op.credentialGeneration + 1,
      ]),
    ).toBeNull();
    expect(
      await first(f.kit.env.DB, sql, [
        op.instanceId,
        op.passId,
        f.apple.id,
        op.credentialGeneration,
      ]),
    ).toBeNull();
  });

  it('denies new wrappers while preserving historical reference fences', async () => {
    const f = await fixture();
    const db = f.kit.env.DB;
    const authority = { kind: 'download' as const, token: f.pass.downloadToken };
    const input = {
      ...f.proof,
      instanceId: crypto.randomUUID(),
      requestKey: crypto.randomUUID(),
      newId: () => crypto.randomUUID(),
      now: f.kit.clock.now(),
      authority,
    };
    expect(
      await createWalletInstanceAndOffer(db, {
        ...input,
        authority: { kind: 'download', token: 'wrong' },
      }),
    ).toBeNull();
    expect(await createWalletInstanceAndOffer(db, input)).toBeNull();
    expect(
      await first(db, 'SELECT id FROM wallet_provider_instances WHERE pass_id = ?', [f.pass.id]),
    ).toBeNull();
    const op = await f.create();
    expect(await createWalletInstanceAndOffer(db, input)).toBeNull();
    expect(
      await createWalletOfferRef(db, { ...reference(op), now: input.now, authority }),
    ).toBeNull();
    expect(
      await all(db, 'SELECT ref_hash FROM wallet_provider_offer_refs WHERE instance_id = ?', [
        op.instanceId,
      ]),
    ).toEqual([]);
    const firstRef = await seedHistoricalOffer(db, op, input.now, input.now + 60_000);
    const secondRef = await seedHistoricalOffer(db, op, input.now, input.now + 60_000);
    expect(firstRef).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(firstRef).not.toBe(secondRef);
    const hash = await sha256Hex(firstRef);
    const rows = await all<{ ref_hash: string }>(
      db,
      'SELECT ref_hash FROM wallet_provider_offer_refs WHERE instance_id = ?',
      [op.instanceId],
    );
    expect(rows.map((row) => row.ref_hash)).toContain(hash);
    expect(JSON.stringify(rows)).not.toContain(firstRef);
    expect(await readOffer(db, hash, input.now, op.credentialKeysetCommitment)).toMatchObject({
      instanceId: op.instanceId,
    });
    expect(await readOffer(db, hash, input.now + 60_000, op.credentialKeysetCommitment)).toBeNull();
    expect(
      await consumeWalletOfferRef(db, firstRef, input.now, op.credentialKeysetCommitment),
    ).toBeNull();
    expect(await walletOfferFresh(db, firstRef, input.now, op.credentialKeysetCommitment)).toBe(
      false,
    );
    await expect(
      consumeOffer(db, hash, input.now, op.credentialKeysetCommitment),
    ).rejects.toThrow();
    expect(
      await first(db, 'SELECT consumed_at FROM wallet_provider_offer_refs WHERE ref_hash = ?', [
        hash,
      ]),
    ).toEqual({ consumed_at: null });
    await run(db, 'UPDATE passes SET download_token = ? WHERE id = ?', [
      crypto.randomUUID(),
      f.pass.id,
    ]);
    expect(
      await readOffer(db, await sha256Hex(secondRef), input.now, op.credentialKeysetCommitment),
    ).toBeNull();
    expect(
      await consumeWalletOfferRef(db, secondRef, input.now, op.credentialKeysetCommitment),
    ).toBeNull();
  });

  it('uses the supplied clock for historical offer and claim evidence expiry while denying creation', async () => {
    const f = await fixture();
    const db = f.kit.env.DB;
    const evidence = await first<{ expires_at: number }>(
      db,
      `SELECT e.expires_at
      FROM template_releases r JOIN wallet_provider_projection_evidence e ON e.candidate_id = r.candidate_id
      WHERE r.id = ? AND e.status = 'verified'`,
      [f.proof.projectionReleaseId],
    );
    if (!evidence) throw new Error('Expected verified provider evidence');
    const before = evidence.expires_at - 1;
    const issued = await f.create();
    const ref = await seedHistoricalOffer(db, issued, before, before + 60_000);
    expect(
      await readOffer(db, await sha256Hex(ref), before, issued.credentialKeysetCommitment),
    ).toMatchObject({ instanceId: issued.instanceId });
    const claim = { ...reference(issued), claimHandle: newWalletClaimHandle(), now: before };
    expect(await claimWalletOperation(db, claim)).toBe('claimed');
    expect(await walletOperationFresh(db, { ...claim, now: evidence.expires_at })).toBe(false);
    expect(
      await readOffer(
        db,
        await sha256Hex(ref),
        evidence.expires_at,
        issued.credentialKeysetCommitment,
      ),
    ).toBeNull();
    expect(
      await consumeWalletOfferRef(db, ref, evidence.expires_at, issued.credentialKeysetCommitment),
    ).toBeNull();
    const second = await f.kit.pass();
    const snapshot = await readWalletPassSnapshot(db, { ...f.scope, passId: second.id });
    if (!snapshot) throw new Error('Second pass is missing');
    const pending = await f.create({
      ...f.proof,
      passId: second.id,
      passVersion: snapshot.passVersion,
      passRevision: snapshot.passRevision,
      passCredentialGeneration: snapshot.credentialGeneration,
      lifecycleGeneration: snapshot.lifecycleGeneration,
      issuingReleaseId: snapshot.issuingReleaseId,
    });
    expect(
      await claimWalletOperation(db, {
        ...reference(pending),
        claimHandle: newWalletClaimHandle(),
        now: evidence.expires_at,
      }),
    ).toBe('not_claimable');
    const third = await f.kit.pass();
    const thirdSnapshot = await readWalletPassSnapshot(db, { ...f.scope, passId: third.id });
    if (!thirdSnapshot) throw new Error('Third pass is missing');
    expect(
      await whileDisabledForTest(createWalletInstance, db, {
        ...f.proof,
        passId: third.id,
        passVersion: thirdSnapshot.passVersion,
        passRevision: thirdSnapshot.passRevision,
        passCredentialGeneration: thirdSnapshot.credentialGeneration,
        lifecycleGeneration: thirdSnapshot.lifecycleGeneration,
        issuingReleaseId: thirdSnapshot.issuingReleaseId,
        instanceId: crypto.randomUUID(),
        requestKey: crypto.randomUUID(),
        newId: () => crypto.randomUUID(),
        now: evidence.expires_at,
      }),
    ).toBeNull();
  });

  it('serializes revocation after an in-flight update and discards the stale provider result', async () => {
    const f = await fixture();
    const db = f.kit.env.DB;
    const op = await f.create();
    const now = f.kit.clock.now();
    const oldClaim = { ...reference(op), claimHandle: newWalletClaimHandle(), now };
    expect(await claimWalletOperation(db, oldClaim)).toBe('claimed');
    expect(await claimWalletOperation(db, oldClaim)).toBe('already_claimed');
    expect(
      await claimWalletOperation(db, { ...oldClaim, claimHandle: newWalletClaimHandle() }),
    ).toBe('not_claimable');
    await run(
      db,
      'UPDATE passes SET removed_at = ?, lifecycle_generation = lifecycle_generation + 1 WHERE id = ?',
      [now, f.pass.id],
    );
    const revoke = await queueWalletOperation(db, {
      ...(await f.current()),
      instanceId: op.instanceId,
      expectedVersion: op.version,
      kind: 'revoke',
      requestKey: crypto.randomUUID(),
      newId: () => crypto.randomUUID(),
      now,
    });
    if (!revoke) throw new Error('Revocation not queued');
    const revokeClaim = { ...reference(revoke), claimHandle: newWalletClaimHandle(), now: now + 1 };
    expect(revoke.version).toBeGreaterThan(op.version);
    expect(await walletOperationFresh(db, oldClaim)).toBe(false);
    expect(await claimWalletOperation(db, revokeClaim)).toBe('not_claimable');
    expect(
      await completeWalletOperation(f.kit.ctx, {
        ...oldClaim,
        now: now + 2,
        result: { kind: 'success', rawBody: new TextEncoder().encode('stale private data') },
      }),
    ).toBe('superseded');
    expect(
      await all(db, 'SELECT id FROM wallet_provider_instance_outcomes WHERE operation_id = ?', [
        op.id,
      ]),
    ).toEqual([]);
    expect(await claimWalletOperation(db, revokeClaim)).toBe('claimed');
    expect(
      await completeWalletOperation(f.kit.ctx, {
        ...revokeClaim,
        now: now + 3,
        result: { kind: 'success' },
      }),
    ).toBe('succeeded');
    expect(await getWalletInstance(db, { ...f.scope, passId: f.pass.id })).toMatchObject({
      lifecycle: 'revoked',
      installationState: 'unknown',
      installationObservedAt: null,
    });
  });

  it('retains encrypted response bytes idempotently and bounds retry attempts and backoff', async () => {
    const f = await fixture();
    const db = f.kit.env.DB;
    const op = await f.create();
    let now = f.kit.clock.now();
    for (let attempt = 1; attempt <= 8; attempt++) {
      const claim = { ...reference(op), claimHandle: newWalletClaimHandle(), now };
      expect(await claimWalletOperation(db, claim)).toBe('claimed');
      if (attempt === 1) {
        const body = new TextEncoder().encode('private-response-body');
        const event = {
          ...claim,
          sequence: 1,
          eventKey: 'class-post-1',
          body,
          reason: 'rate_limited' as const,
          httpStatus: 429,
        };
        expect(await recordWalletOperationOutcome(f.kit.ctx, event)).toBe('recorded');
        expect(await recordWalletOperationOutcome(f.kit.ctx, event)).toBe('replay');
        expect(
          await recordWalletOperationOutcome(f.kit.ctx, {
            ...event,
            body: new TextEncoder().encode('different'),
          }),
        ).toBe('conflict');
        const stored = await first<{ ciphertext: unknown }>(
          db,
          'SELECT ciphertext FROM wallet_provider_instance_outcomes WHERE operation_id = ?',
          [op.id],
        );
        expect(JSON.stringify(stored)).not.toContain('private-response-body');
      }
      const state = await completeWalletOperation(f.kit.ctx, {
        ...claim,
        result: {
          kind: 'failure',
          reason: 'rate_limited',
          retryable: true,
          httpStatus: 429,
          retryAfterMs: 1_000,
        },
      });
      expect(state).toBe(attempt === 8 ? 'failed' : 'retry');
      const stored = await getWalletOperation(db, reference(op));
      expect(stored?.attempts).toBe(attempt);
      if (attempt < 8) {
        expect(stored?.nextAttemptAt).toBeGreaterThan(now);
        expect(stored?.nextAttemptAt).toBeLessThanOrEqual(now + 300_000);
      }
      now = (stored?.nextAttemptAt ?? now) + 1;
    }
    expect(
      await claimWalletOperation(db, {
        ...reference(op),
        now,
        claimHandle: newWalletClaimHandle(),
      }),
    ).toBe('not_claimable');
  });

  it('holds uncertain work and durably marks changed passes for reconciliation', async () => {
    const f = await fixture();
    const db = f.kit.env.DB;
    const op = await f.create();
    const claim = { ...reference(op), claimHandle: newWalletClaimHandle(), now: f.kit.clock.now() };
    expect(await claimWalletOperation(db, claim)).toBe('claimed');
    expect(await markWalletClaimUncertain(db, claim)).toBe(true);
    await run(db, 'UPDATE passes SET revision = revision + 1 WHERE id = ?', [f.pass.id]);
    const dirty = await listDirtyWalletInstances(
      db,
      claim.now,
      100,
      claim.credentialKeysetCommitment,
    );
    expect(dirty.some((row) => row.instanceId === op.instanceId)).toBe(true);
    const next = await queueWalletOperation(db, {
      ...(await f.current()),
      instanceId: op.instanceId,
      expectedVersion: op.version,
      kind: 'upsert',
      requestKey: crypto.randomUUID(),
      newId: () => crypto.randomUUID(),
      now: claim.now,
    });
    if (!next) throw new Error('Updated operation not queued');
    expect(
      await claimWalletOperation(db, {
        ...reference(next),
        claimHandle: newWalletClaimHandle(),
        now: claim.now,
      }),
    ).toBe('not_claimable');
    expect(
      await completeWalletOperation(f.kit.ctx, { ...claim, result: { kind: 'success' } }),
    ).toBe('superseded');
    expect(
      await claimWalletOperation(db, {
        ...reference(next),
        claimHandle: newWalletClaimHandle(),
        now: claim.now,
      }),
    ).toBe('claimed');
  });

  it('does not infer installation from successful provider updates', async () => {
    const f = await fixture();
    const op = await f.create();
    const claim = { ...reference(op), claimHandle: newWalletClaimHandle(), now: f.kit.clock.now() };
    expect(await claimWalletOperation(f.kit.env.DB, claim)).toBe('claimed');
    expect(
      await completeWalletOperation(f.kit.ctx, {
        ...claim,
        result: { kind: 'success', httpStatus: 200 },
      }),
    ).toBe('succeeded');
    expect(await getWalletInstance(f.kit.env.DB, { ...f.scope, passId: f.pass.id })).toMatchObject({
      installationState: 'unknown',
      installationObservedAt: null,
    });
  });

  it('never treats callback labels as device installation evidence', async () => {
    const f = await fixture();
    const db = f.kit.env.DB;
    const op = await f.create();
    const now = f.kit.clock.now();
    for (const [index, kind] of ['installed', 'uninstalled'].entries()) {
      await run(
        db,
        `INSERT INTO wallet_provider_callback_events
        (account_id, event_id_hash, payload_hash, instance_id, operation_version, kind, observed_at, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          f.proof.accountId,
          String(index).repeat(64),
          'a'.repeat(64),
          op.instanceId,
          op.version,
          kind,
          now,
          now,
        ],
      );
    }
    await expect(
      run(
        db,
        `UPDATE wallet_provider_instances SET installation_state = 'installed',
      installation_observed_at = ? WHERE id = ?`,
        [now, op.instanceId],
      ),
    ).rejects.toThrow();
    expect(await getWalletInstance(db, { ...f.scope, passId: f.pass.id })).toMatchObject({
      installationState: 'unknown',
      installationObservedAt: null,
    });
  });

  it('restores the same instance only after an older revocation settles and generation advances', async () => {
    const f = await fixture();
    const db = f.kit.env.DB;
    const op = await f.create();
    const now = f.kit.clock.now();
    await run(
      db,
      'UPDATE passes SET removed_at = ?, lifecycle_generation = lifecycle_generation + 1 WHERE id = ?',
      [now, f.pass.id],
    );
    const revoke = await queueWalletOperation(db, {
      ...(await f.current()),
      instanceId: op.instanceId,
      expectedVersion: op.version,
      kind: 'revoke',
      requestKey: crypto.randomUUID(),
      newId: () => crypto.randomUUID(),
      now,
    });
    if (!revoke) throw new Error('Revocation not queued');
    const claim = { ...reference(revoke), claimHandle: newWalletClaimHandle(), now };
    expect(await claimWalletOperation(db, claim)).toBe('claimed');
    await run(
      db,
      'UPDATE passes SET removed_at = NULL, lifecycle_generation = lifecycle_generation + 1 WHERE id = ?',
      [f.pass.id],
    );
    const restore = {
      ...(await f.current()),
      instanceId: op.instanceId,
      expectedVersion: revoke.version,
      kind: 'upsert' as const,
      requestKey: crypto.randomUUID(),
      newId: () => crypto.randomUUID(),
      now,
    };
    expect(await queueWalletOperation(db, restore)).toBeNull();
    expect(
      await completeWalletOperation(f.kit.ctx, { ...claim, result: { kind: 'success' } }),
    ).toBe('superseded');
    const next = await queueWalletOperation(db, restore);
    expect(next).toMatchObject({
      instanceId: op.instanceId,
      version: revoke.version + 1,
      state: 'pending',
    });
    expect(await getWalletInstance(db, { ...f.scope, passId: f.pass.id })).toMatchObject({
      lifecycle: 'active',
      desiredVersion: revoke.version + 1,
      installationState: 'unknown',
    });
  });

  it('blocks new revoke work during a pre-CAS reservation without blocking an already claimed revoke', async () => {
    const f = await fixture();
    const db = f.kit.env.DB;
    const now = f.kit.clock.now();
    const op = await f.create();
    const other = await f.kit.pass();
    const snapshot = await readWalletPassSnapshot(db, { ...f.scope, passId: other.id });
    if (!snapshot) throw new Error('Missing second pass snapshot');
    const otherProof = {
      ...f.proof,
      passId: other.id,
      passVersion: snapshot.passVersion,
      passRevision: snapshot.passRevision,
      lifecycleGeneration: snapshot.lifecycleGeneration,
      passCredentialGeneration: snapshot.credentialGeneration,
      issuingReleaseId: snapshot.issuingReleaseId,
    };
    const otherOp = await f.create(otherProof);
    const existing = await queueWalletOperation(db, {
      ...otherProof,
      instanceId: otherOp.instanceId,
      expectedVersion: otherOp.version,
      kind: 'revoke',
      requestKey: crypto.randomUUID(),
      newId: () => crypto.randomUUID(),
      now,
    });
    if (!existing) throw new Error('Control revocation not queued');
    const claim = { ...reference(existing), claimHandle: newWalletClaimHandle(), now };
    expect(await claimWalletOperation(db, claim)).toBe('claimed');

    // Model the reservation statement before START's credential CAS, without advancing either pass.
    async function reserve(passId: string) {
      const result = await run(
        db,
        `INSERT INTO pass_credential_transfers
        (id, pass_id, org_id, mode, state, source_generation, source_version, source_revision, source_row_version,
         source_lifecycle_generation, source_link_generation, target_holder_email, target_owner_user_id,
         requested_by_type, requested_by_id, requested_at)
        SELECT ?, id, org_id, mode, 'pending', credential_generation, version, revision, row_version,
          lifecycle_generation, link_generation + 1, 'next-holder@example.test', NULL, 'system', NULL, ?
        FROM passes WHERE id = ?`,
        [crypto.randomUUID(), now, passId],
      );
      expect(result.changes).toBe(1);
    }
    await reserve(f.pass.id);
    await reserve(other.id);
    expect(
      await first(
        db,
        `SELECT p.credential_generation, t.source_generation, t.state
      FROM passes p JOIN pass_credential_transfers t ON t.pass_id = p.id WHERE p.id = ?`,
        [f.pass.id],
      ),
    ).toEqual({
      credential_generation: op.credentialGeneration,
      source_generation: op.credentialGeneration,
      state: 'pending',
    });
    expect(
      await queueWalletOperation(db, {
        ...f.proof,
        instanceId: op.instanceId,
        expectedVersion: op.version,
        kind: 'revoke',
        requestKey: crypto.randomUUID(),
        newId: () => crypto.randomUUID(),
        now,
      }),
    ).toBeNull();
    expect(await getWalletInstanceById(db, reference(op))).toMatchObject({
      lifecycle: 'active',
      desiredVersion: op.version,
      desiredOperationId: op.id,
    });
    expect(await getWalletOperation(db, reference(op))).toMatchObject({ state: 'pending' });
    expect(
      await all(
        db,
        'SELECT version FROM wallet_provider_instance_operations WHERE instance_id = ?',
        [op.instanceId],
      ),
    ).toEqual([{ version: op.version }]);
    expect(
      await completeWalletOperation(f.kit.ctx, { ...claim, result: { kind: 'success' } }),
    ).toBe('succeeded');
    expect(await getWalletOperation(db, reference(existing))).toMatchObject({ state: 'succeeded' });
  }, 120_000);

  it('blocks both target incarnations until old in-flight work and retirement settle', async () => {
    // Retirement gating applies to historical instances, which exist only while a provider is enabled.
    onTestFinished(setWalletProvidersEnabledForTest(true));
    const f = await fixture();
    const db = f.kit.env.DB;
    const op = await f.create();
    const now = f.kit.clock.now();
    const ref = await seedHistoricalOffer(db, op, now, now + 60_000);
    const oldClaim = { ...reference(op), claimHandle: newWalletClaimHandle(), now };
    expect(await claimWalletOperation(db, oldClaim)).toBe('claimed');
    await expect(run(db, 'DELETE FROM passes WHERE id = ?', [f.pass.id])).rejects.toThrow();
    await expect(
      run(db, 'INSERT OR REPLACE INTO passes SELECT * FROM passes WHERE id = ?', [f.pass.id]),
    ).rejects.toThrow();
    const other = await f.kit.pass();
    await expect(
      run(
        db,
        `UPDATE OR REPLACE passes SET download_token =
      (SELECT download_token FROM passes WHERE id = ?) WHERE id = ?`,
        [f.pass.id, other.id],
      ),
    ).rejects.toThrow();

    const expected = await getHolderPass(db, f.pass.id, null);
    if (!expected) throw new Error('Missing holder transfer snapshot');
    const transfer = await startCredentialTransfer(
      jobCtxOf(f.kit),
      { type: 'system', id: null },
      f.pass.id,
      { holderEmail: 'next-holder@example.test', ownerUserId: null },
      null,
      { kind: 'tenant-holder', expected },
    );
    expect(transfer.state).toBe('pending');
    const staged = await all<{
      id: string;
      provider: string;
      lifecycle: string;
      desired_version: number;
    }>(
      db,
      `SELECT id, provider, lifecycle, desired_version FROM wallet_provider_instances
       WHERE pass_id = ? AND credential_generation = ? ORDER BY provider`,
      [f.pass.id, op.credentialGeneration + 1],
    );
    expect(staged).toHaveLength(2);
    expect(staged.map((row) => row.provider)).toEqual(['google', 'samsung']);
    expect(staged.every((row) => row.lifecycle === 'blocked' && row.desired_version === 0)).toBe(
      true,
    );
    expect(await getWalletInstanceById(db, reference(op))).toMatchObject({
      retirementRequestedAt: expect.any(Number),
    });
    expect(await walletOperationFresh(db, oldClaim)).toBe(false);
    expect(
      await readOffer(db, await sha256Hex(ref), now, op.credentialKeysetCommitment),
    ).toBeNull();
    expect(await finishCredentialTransfer(jobCtxOf(f.kit), transfer.transferId)).toMatchObject({
      state: 'pending',
    });
    await expect(
      run(db, 'UPDATE passes SET credential_generation = credential_generation + 1 WHERE id = ?', [
        f.pass.id,
      ]),
    ).rejects.toThrow();
    expect(
      await queueWalletOperation(db, {
        ...f.proof,
        instanceId: op.instanceId,
        expectedVersion: op.version,
        kind: 'revoke',
        requestKey: crypto.randomUUID(),
        newId: () => crypto.randomUUID(),
        now,
      }),
    ).toBeNull();
    const revoke = await queueWalletOperation(db, {
      ...(await f.current()),
      instanceId: op.instanceId,
      expectedVersion: op.version,
      kind: 'revoke',
      requestKey: crypto.randomUUID(),
      newId: () => crypto.randomUUID(),
      now,
    });
    if (!revoke) throw new Error('Historical revoke not queued');
    const revokeClaim = { ...reference(revoke), claimHandle: newWalletClaimHandle(), now };
    expect(await claimWalletOperation(db, revokeClaim)).toBe('not_claimable');
    expect(
      await completeWalletOperation(f.kit.ctx, { ...oldClaim, result: { kind: 'success' } }),
    ).toBe('superseded');
    expect(await finishCredentialTransfer(jobCtxOf(f.kit), transfer.transferId)).toMatchObject({
      state: 'pending',
    });
    expect(await claimWalletOperation(db, revokeClaim)).toBe('claimed');
    expect(
      await completeWalletOperation(f.kit.ctx, { ...revokeClaim, result: { kind: 'not_issued' } }),
    ).toBe('succeeded');
    expect(await finishCredentialTransfer(jobCtxOf(f.kit), transfer.transferId)).toMatchObject({
      state: 'pending',
    });
    expect(await retireWalletInstance(db, { ...reference(revoke), now })).toBe(true);
    expect(await finishCredentialTransfer(jobCtxOf(f.kit), transfer.transferId)).toMatchObject({
      state: 'completed',
    });

    const ready = await all<{
      id: string;
      lifecycle: string;
      account_id: string | null;
      desired_version: number;
    }>(
      db,
      `SELECT id, lifecycle, account_id, desired_version FROM wallet_provider_instances
       WHERE pass_id = ? AND credential_generation = ? ORDER BY provider`,
      [f.pass.id, op.credentialGeneration + 1],
    );
    expect(ready.map((row) => row.lifecycle)).toEqual(['ready', 'ready']);
    expect(ready.map((row) => row.id)).toEqual(staged.map((row) => row.id));
    expect(ready.every((row) => row.account_id === null && row.desired_version === 0)).toBe(true);
    expect(
      await whileDisabledForTest(createWalletInstance, db, {
        ...(await f.current()),
        instanceId: crypto.randomUUID(),
        requestKey: crypto.randomUUID(),
        newId: () => crypto.randomUUID(),
        now,
      }),
    ).toBeNull();

    const currentHolder = await getHolderPass(db, f.pass.id, null);
    if (!currentHolder) throw new Error('Missing transferred holder snapshot');
    const nextTransfer = await startCredentialTransfer(
      jobCtxOf(f.kit),
      { type: 'system', id: null },
      f.pass.id,
      { holderEmail: 'another-holder@example.test', ownerUserId: null },
      null,
      { kind: 'tenant-holder', expected: currentHolder },
    );
    expect(nextTransfer.state).toBe('completed');
    const history = await all<{
      id: string;
      credential_generation: number;
      lifecycle: string;
      retirement_reason: string | null;
    }>(
      db,
      `SELECT id, credential_generation, lifecycle, retirement_reason FROM wallet_provider_instances
       WHERE pass_id = ? AND credential_generation >= ? ORDER BY credential_generation, provider`,
      [f.pass.id, op.credentialGeneration + 1],
    );
    expect(
      history
        .filter((row) => row.credential_generation === op.credentialGeneration + 1)
        .every((row) => row.lifecycle === 'retired' && row.retirement_reason === 'not_issued'),
    ).toBe(true);
    const newest = history.filter(
      (row) => row.credential_generation === op.credentialGeneration + 2,
    );
    expect(newest).toHaveLength(2);
    expect(
      newest.every((row) => row.lifecycle === 'ready' && !staged.some((old) => old.id === row.id)),
    ).toBe(true);
  }, 120_000);

  it('retires an expired historical Samsung ref and denies a new ref after restore', async () => {
    const f = await fixture();
    const db = f.kit.env.DB;
    const op = await f.create();
    const now = f.kit.clock.now();
    const refScope = {
      orgId: op.orgId,
      mode: op.mode,
      instanceId: op.instanceId,
      operationVersion: op.version,
      credentialKeysetCommitment: op.credentialKeysetCommitment,
    };
    const original = await seedHistoricalSamsungRef(f.kit.ctx, op, now, now + 1_000, false);
    await run(
      db,
      'UPDATE passes SET removed_at = ?, lifecycle_generation = lifecycle_generation + 1 WHERE id = ?',
      [now, f.pass.id],
    );
    const revoke = await queueWalletOperation(db, {
      ...(await f.current()),
      instanceId: op.instanceId,
      expectedVersion: op.version,
      kind: 'revoke',
      requestKey: crypto.randomUUID(),
      newId: () => crypto.randomUUID(),
      now,
    });
    if (!revoke) throw new Error('Revocation not queued');
    const claim = { ...reference(revoke), claimHandle: newWalletClaimHandle(), now };
    const revokeScope = { ...refScope, operationVersion: revoke.version };
    expect(await claimWalletOperation(db, claim)).toBe('claimed');
    expect(await inspectSamsungRefRetirement(f.kit.ctx, revokeScope)).toBe('pending');
    f.kit.clock.advance(1_001);
    expect(
      await retireExpiredUnpromotedRef(f.kit.ctx, {
        ...revokeScope,
        claimHandle: claim.claimHandle,
      }),
    ).toBe('no_external_card');
    expect(
      await completeWalletOperation(f.kit.ctx, {
        ...claim,
        now: f.kit.clock.now(),
        result: { kind: 'not_issued' },
      }),
    ).toBe('succeeded');
    await run(
      db,
      'UPDATE passes SET removed_at = NULL, lifecycle_generation = lifecycle_generation + 1 WHERE id = ?',
      [f.pass.id],
    );
    const restored = await queueWalletOperation(db, {
      ...(await f.current()),
      instanceId: op.instanceId,
      expectedVersion: revoke.version,
      kind: 'upsert',
      requestKey: crypto.randomUUID(),
      newId: () => crypto.randomUUID(),
      now: f.kit.clock.now(),
    });
    if (!restored) throw new Error('Restore not queued');
    const replacement = await whileDisabledForTest(ensureSamsungFetchRef, f.kit.ctx, {
      ...refScope,
      operationVersion: restored.version,
      expiresAt: f.kit.clock.now() + 1_000,
    });
    expect(replacement).toBeNull();
    const refs = await all<{ ref_hash: string; retired_at: number | null }>(
      db,
      'SELECT ref_hash, retired_at FROM wallet_samsung_fetch_refs WHERE instance_id = ?',
      [op.instanceId],
    );
    expect(refs).toHaveLength(1);
    const originalHash = await sha256Hex(original);
    expect(refs.find((row) => row.ref_hash === originalHash)?.retired_at).not.toBeNull();
  });

  it('retains a historically promoted Samsung ref for provider notification', async () => {
    const f = await fixture();
    const db = f.kit.env.DB;
    const op = await f.create();
    const now = f.kit.clock.now();
    const refScope = {
      orgId: op.orgId,
      mode: op.mode,
      instanceId: op.instanceId,
      operationVersion: op.version,
      credentialKeysetCommitment: op.credentialKeysetCommitment,
    };
    const ref = await seedHistoricalSamsungRef(f.kit.ctx, op, now, now + 1_000, true);
    await run(
      db,
      'UPDATE passes SET removed_at = ?, lifecycle_generation = lifecycle_generation + 1 WHERE id = ?',
      [now, f.pass.id],
    );
    const revoke = await queueWalletOperation(db, {
      ...(await f.current()),
      instanceId: op.instanceId,
      expectedVersion: op.version,
      kind: 'revoke',
      requestKey: crypto.randomUUID(),
      newId: () => crypto.randomUUID(),
      now,
    });
    if (!revoke) throw new Error('Revocation not queued');
    const claim = { ...reference(revoke), claimHandle: newWalletClaimHandle(), now };
    const revokeScope = { ...refScope, operationVersion: revoke.version };
    expect(await claimWalletOperation(db, claim)).toBe('claimed');
    f.kit.clock.advance(1_001);
    expect(await inspectSamsungRefRetirement(f.kit.ctx, revokeScope)).toBe('needs_notification');
    expect(
      await retireExpiredUnpromotedRef(f.kit.ctx, {
        ...revokeScope,
        claimHandle: claim.claimHandle,
      }),
    ).toBe('needs_notification');
    expect(
      await completeWalletOperation(f.kit.ctx, {
        ...claim,
        now: f.kit.clock.now(),
        result: { kind: 'not_issued' },
      }),
    ).toBeNull();
    expect(
      await first(db, 'SELECT retired_at FROM wallet_samsung_fetch_refs WHERE ref_hash = ?', [
        await sha256Hex(ref),
      ]),
    ).toEqual({ retired_at: null });
  });

  it('blocks retention purge until a confirmed revoke and terminal retirement', async () => {
    // Retirement gating applies to historical instances, which exist only while a provider is enabled.
    onTestFinished(setWalletProvidersEnabledForTest(true));
    const f = await fixture();
    const db = f.kit.env.DB;
    const op = await f.create();
    const now = f.kit.clock.now();
    await run(
      db,
      'UPDATE passes SET deleted_at = ?, lifecycle_generation = lifecycle_generation + 1 WHERE id = ?',
      [now, f.pass.id],
    );
    const deletedPass = await getPassBySerial(db, f.pass.identityId, f.pass.serial);
    if (!deletedPass) throw new Error('Missing deleted pass snapshot');
    const retention = await prepareScanRetentionDelete(f.kit.env, deletedPass);
    expect((await expiredDeletedPasses(db, now + 1, '', 100)).some((p) => p.id === f.pass.id)).toBe(
      false,
    );
    expect(
      (await deletePassRows(db, deletedPass, retention, op.credentialKeysetCommitment)).deleted,
    ).toBe(false);
    const snapshot = await f.current();
    expect(await requestWalletRetirement(db, { ...reference(op), ...snapshot, now })).toBe(true);
    const revoke = await queueWalletOperation(db, {
      ...snapshot,
      instanceId: op.instanceId,
      expectedVersion: op.version,
      kind: 'revoke',
      requestKey: crypto.randomUUID(),
      newId: () => crypto.randomUUID(),
      now,
    });
    if (!revoke) throw new Error('Retirement revoke not queued');
    const claim = { ...reference(revoke), claimHandle: newWalletClaimHandle(), now };
    expect(await claimWalletOperation(db, claim)).toBe('claimed');
    expect(
      (await deletePassRows(db, deletedPass, retention, op.credentialKeysetCommitment)).deleted,
    ).toBe(false);
    expect(await markWalletClaimUncertain(db, claim)).toBe(true);
    expect(
      (await deletePassRows(db, deletedPass, retention, op.credentialKeysetCommitment)).deleted,
    ).toBe(false);
    expect(
      await completeWalletOperation(f.kit.ctx, {
        ...claim,
        result: { kind: 'failure', reason: 'unavailable', retryable: true },
      }),
    ).toBe('retry');
    expect(
      (await deletePassRows(db, deletedPass, retention, op.credentialKeysetCommitment)).deleted,
    ).toBe(false);
    const retry = { ...reference(revoke), claimHandle: newWalletClaimHandle(), now: now + 1_001 };
    expect(await claimWalletOperation(db, retry)).toBe('claimed');
    expect(
      await completeWalletOperation(f.kit.ctx, { ...retry, result: { kind: 'success' } }),
    ).toBe('succeeded');
    expect(await retireWalletInstance(db, { ...reference(revoke), now: now + 1_002 })).toBe(true);
    expect((await expiredDeletedPasses(db, now + 1, '', 100)).some((p) => p.id === f.pass.id)).toBe(
      true,
    );
    expect(
      (await deletePassRows(db, deletedPass, retention, op.credentialKeysetCommitment)).deleted,
    ).toBe(true);
  });

  it('rechecks provider retirement when deleting a previously selected pass', async () => {
    // Retirement gating applies to historical instances, which exist only while a provider is enabled.
    onTestFinished(setWalletProvidersEnabledForTest(true));
    const f = await fixture();
    const db = f.kit.env.DB;
    const now = f.kit.clock.now();
    await run(db, 'UPDATE passes SET deleted_at = ? WHERE id = ?', [now, f.pass.id]);
    const candidate = (await expiredDeletedPasses(db, now + 1, '', 100)).find(
      (p) => p.id === f.pass.id,
    );
    if (!candidate) throw new Error('Expected an initially purgeable candidate');
    const retention = await prepareScanRetentionDelete(f.kit.env, candidate);
    // Inject a historical identity after selection without changing the pass snapshot itself.
    await f.create();
    expect((await expiredDeletedPasses(db, now + 1, '', 100)).some((p) => p.id === f.pass.id)).toBe(
      false,
    );
    expect(
      (await deletePassRows(db, candidate, retention, f.credentialKeysetCommitment)).deleted,
    ).toBe(false);
  });
});
