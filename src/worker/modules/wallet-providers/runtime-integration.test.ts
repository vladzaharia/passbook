import { CompactSign, importPKCS8 } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { credentialAad, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { batch, first, run, stmt } from '../../platform/db.ts';
import { fromBase64, sha256Hex } from '../../platform/ids.ts';
import { interveneAtD1 } from '../apple/credential-transfer-test-fixtures.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import {
  credentialRefKeysetCommitment,
  requireCredentialRefKeyset,
} from '../passes/credential-keyset.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { withKitDatabase } from '../passes/pass-test-fixtures.ts';
import {
  configureWalletProviderAccount,
  getWalletProviderReadiness,
  readWalletProviderRetirementCredentials,
  revokeWalletProviderAccount,
} from './account-service.ts';
import { googleObjectIds } from './google-ids.ts';
import { readWalletPassSnapshot, walletClaimHash } from './instance.ts';
import { setupWalletOfferKit as setupOfferFixture } from './offers-test-fixtures.ts';
import { getApprovedProjection } from './projection-service.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import {
  findRetirementAccount,
  findSamsungPromotedRefreshAccount,
  saveAccountConfiguration,
} from './repo-accounts.ts';
import { projectionReleaseBindingValid } from './repo-projection.ts';
import {
  assertWalletRuntimeAccount,
  inactivateGoogleRuntimeObject,
  samsungRuntimeCardDataResponse,
  sendSamsungRuntimeUpdate,
  verifySamsungRuntimeRequest,
  verifySamsungTombstoneRuntimeRequest,
  type WalletRetirementClaim,
  type WalletRuntimeScope,
} from './runtime.ts';
import {
  runtimeGoogleLegacyFixture as setupGoogleLegacyFixture,
  runtimeSamsungLegacyFixture as setupSamsungLegacyFixture,
} from './runtime-integration-fixtures.ts';
import { SamsungNotificationError, SamsungReplayStoreError, SamsungTokenError } from './samsung.ts';

// These cases cover historical provider instances, which exist only while a provider is enabled.
beforeAll(() => {
  setWalletProvidersEnabledForTest(true);
});

afterEach(() => vi.unstubAllGlobals());

const testEnv = installKeysetTestEnv();

async function setupWalletOfferKit(options: Parameters<typeof setupOfferFixture>[0] = {}) {
  return setupOfferFixture({ ...options, db: (await testEnv()).DB });
}

async function runtimeGoogleLegacyFixture() {
  return setupGoogleLegacyFixture({ db: (await testEnv()).DB });
}

async function runtimeSamsungLegacyFixture(kind: 'refresh' | 'retirement', promoted = true) {
  return withKitDatabase((await testEnv()).DB, () => setupSamsungLegacyFixture(kind, promoted));
}

const alternateKek = btoa(String.fromCharCode(...new Uint8Array(32).fill(19)));

async function replaceTestKeyset(
  db: D1Database,
  credentialKeysetCommitment: string,
): Promise<void> {
  await run(db, 'DROP TRIGGER credential_ref_keyset_no_update');
  await run(db, 'UPDATE credential_ref_keyset SET commitment = ? WHERE id = 1', [
    credentialKeysetCommitment,
  ]);
}

async function publishedProjectionBindingFixture() {
  const fixture = await setupWalletOfferKit({ google: 'absent', samsung: 'published' });
  const release = fixture.samsungRelease;
  const candidateId = release?.candidateId;
  const accountRevision = release?.accountRevision;
  if (!release || !candidateId || !release.approvalId || accountRevision === undefined)
    throw new Error('Missing published projection fixture');
  return {
    ...fixture,
    candidateId,
    accountRevision,
    binding: {
      releaseId: release.id,
      orgId: fixture.pass.orgId,
      mode: fixture.pass.mode,
      provider: 'samsung' as const,
      templateId: fixture.pass.templateId,
      version: fixture.pass.templateVersion,
      sourceReleaseId: fixture.apple.id,
      now: fixture.kit.clock.now(),
      credentialKeysetCommitment: fixture.credentialKeysetCommitment,
    },
  };
}

describe('existing provider instance runtime', () => {
  it('compiles the actual projection fence and rejects stale scope and release heads', async () => {
    const f = await publishedProjectionBindingFixture();
    const captured: { sql: string; params: unknown[] }[] = [];
    const db = new Proxy(f.kit.env.DB, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql: string) => {
            const statement = target.prepare(sql);
            return new Proxy(statement, {
              get(prepared, method) {
                if (method === 'bind') {
                  return (...params: unknown[]) => {
                    captured.push({ sql, params });
                    return prepared.bind(...params);
                  };
                }
                const value = Reflect.get(prepared, method, prepared);
                return typeof value === 'function' ? value.bind(prepared) : value;
              },
            });
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    expect(await projectionReleaseBindingValid(db, f.binding)).toBe(true);
    expect(captured.length).toBe(1);
    const statement = captured[0];
    if (!statement) throw new Error('Projection statement was not captured');
    const plan = await f.kit.env.DB.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
      .bind(...statement.params)
      .all();
    expect(plan.results.length).toBeGreaterThan(0);
    expect(
      await getApprovedProjection(
        f.kit.ctx,
        {
          orgId: f.binding.orgId,
          mode: f.binding.mode,
          provider: f.binding.provider,
          templateId: f.binding.templateId,
          templateVersion: f.binding.version,
          appleReleaseId: f.binding.sourceReleaseId,
        },
        { credentialKeysetCommitment: f.binding.credentialKeysetCommitment },
      ),
    ).toMatchObject({ release: { id: f.binding.releaseId } });

    for (const rejected of [
      { ...f.binding, releaseId: 'other-release' },
      { ...f.binding, orgId: 'other-org' },
      { ...f.binding, mode: f.binding.mode === 'live' ? ('test' as const) : ('live' as const) },
      { ...f.binding, provider: 'google' as const },
      { ...f.binding, templateId: 'other-template' },
      { ...f.binding, version: 'other-version' },
      { ...f.binding, sourceReleaseId: 'other-source' },
      { ...f.binding, credentialKeysetCommitment: '0'.repeat(64) },
      { ...f.binding, now: f.binding.now + 300_000 },
    ]) {
      expect(await projectionReleaseBindingValid(f.kit.env.DB, rejected)).toBe(false);
    }

    const newer = await f.publish('samsung', 1);
    const newerBinding = { ...f.binding, releaseId: newer.id };
    expect(await projectionReleaseBindingValid(f.kit.env.DB, f.binding)).toBe(false);
    expect(await projectionReleaseBindingValid(f.kit.env.DB, newerBinding)).toBe(true);
    await approveAppleRelease(f.kit);
    expect(await projectionReleaseBindingValid(f.kit.env.DB, newerBinding)).toBe(false);
  }, 60_000);

  it('keeps reviewer and evidence on the exact release and fences account rotation', async () => {
    const f = await publishedProjectionBindingFixture();
    const db = f.kit.env.DB;
    const newer = await f.publish('samsung', 1);
    const candidateId = newer.candidateId;
    const approvalId = newer.approvalId;
    if (!candidateId || !approvalId) throw new Error('Missing newer projection provenance');
    const binding = { ...f.binding, releaseId: newer.id };
    expect(await projectionReleaseBindingValid(db, binding)).toBe(true);

    const review = await first<{ reviewer: string; author: string }>(
      db,
      `SELECT a.reviewer_id AS reviewer, c.author_id AS author FROM template_approvals a
        JOIN template_candidates c ON c.id = a.candidate_id WHERE a.id = ?`,
      [approvalId],
    );
    const reviewGuard = await first<{ sql: string }>(
      db,
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'template_approvals_immutable'",
    );
    const reviewGuardSql = reviewGuard?.sql;
    if (!review || !reviewGuardSql) throw new Error('Missing approval fixture');
    const setReviewer = async (reviewer: string) => {
      await batch(db, [
        stmt(db, 'DROP TRIGGER template_approvals_immutable'),
        stmt(db, 'UPDATE template_approvals SET reviewer_id = ? WHERE id = ?', [
          reviewer,
          approvalId,
        ]),
        stmt(db, reviewGuardSql),
      ]);
    };
    try {
      await setReviewer(review.author);
      expect(await projectionReleaseBindingValid(db, binding)).toBe(false);
    } finally {
      await setReviewer(review.reviewer);
    }
    expect(await projectionReleaseBindingValid(db, binding)).toBe(true);

    const historyGuard = await first<{ sql: string }>(
      db,
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'wallet_provider_projection_evidence_history_no_update'",
    );
    const historyGuardSql = historyGuard?.sql;
    if (!historyGuardSql) throw new Error('Missing evidence history guard');
    const setCountry = async (country: string) => {
      await batch(db, [
        stmt(db, 'DROP TRIGGER wallet_provider_projection_evidence_history_no_update'),
        stmt(
          db,
          'UPDATE wallet_provider_projection_evidence_history SET country_code = ? WHERE candidate_id = ?',
          [country, candidateId],
        ),
        stmt(db, historyGuardSql),
      ]);
    };
    try {
      await setCountry('ZZ');
      expect(
        await first(
          db,
          'SELECT 1 AS present FROM wallet_provider_projection_evidence WHERE candidate_id = ? AND status = ?',
          [f.candidateId, 'verified'],
        ),
      ).toEqual({ present: 1 });
      expect(await projectionReleaseBindingValid(db, binding)).toBe(false);
    } finally {
      await setCountry('GB');
    }
    expect(await projectionReleaseBindingValid(db, binding)).toBe(true);

    await configureWalletProviderAccount(f.kit.ctx, f.auth, {
      orgId: f.binding.orgId,
      mode: f.binding.mode,
      provider: 'samsung',
      expectedRevision: f.accountRevision,
      credentials: f.samsung,
    });
    expect(await projectionReleaseBindingValid(db, binding)).toBe(false);
  }, 60_000);

  it('releases Google retirement credentials only for the exact claimed object generation', async () => {
    const f = await runtimeGoogleLegacyFixture();
    const db = f.kit.env.DB;
    const proof = {
      orgId: f.scope.orgId,
      mode: f.scope.mode,
      provider: 'google' as const,
      accountId: f.scope.accountId,
      accountRevision: f.scope.accountRevision,
      credentialKeysetCommitment: f.scope.credentialKeysetCommitment,
      projectionReleaseId: f.scope.providerReleaseId,
      instanceId: f.instanceId,
      operationId: f.operationId,
      version: 1,
      claimHash: await walletClaimHash(f.claimHandle),
      passId: f.pass.id,
      identityProjectionReleaseId: f.releaseId,
      credentialGeneration: f.credentialGeneration,
    };
    expect(await readWalletProviderRetirementCredentials(f.kit.ctx, proof)).toMatchObject({
      provider: 'google',
      accountId: proof.accountId,
      revision: proof.accountRevision,
    });
    for (const rejected of [
      { ...proof, orgId: 'other-org' },
      { ...proof, mode: proof.mode === 'live' ? ('test' as const) : ('live' as const) },
      { ...proof, accountId: 'other-account' },
      { ...proof, accountRevision: proof.accountRevision + 1 },
      { ...proof, instanceId: 'other-instance' },
      { ...proof, operationId: 'other-operation' },
      { ...proof, version: proof.version + 1 },
      { ...proof, claimHash: '0'.repeat(64) },
      { ...proof, projectionReleaseId: 'other-release' },
      { ...proof, passId: 'other-pass' },
      { ...proof, identityProjectionReleaseId: 'other-release' },
      { ...proof, credentialGeneration: proof.credentialGeneration + 1 },
    ]) {
      expect(await readWalletProviderRetirementCredentials(f.kit.ctx, rejected)).toBeNull();
    }
    expect(
      await findRetirementAccount(
        db,
        { ...proof, credentialKeysetCommitment: '0'.repeat(64) },
        f.kit.clock.now(),
      ),
    ).toBeNull();
    expect(await findRetirementAccount(db, proof, f.kit.clock.now() + 120_000)).toBeNull();
    await run(
      db,
      "UPDATE wallet_provider_instance_operations SET state = 'uncertain' WHERE id = ?",
      [proof.operationId],
    );
    expect(await readWalletProviderRetirementCredentials(f.kit.ctx, proof)).toBeNull();
  }, 60_000);

  it('keeps Samsung retirement reference, provenance, and pass authority in the same read', async () => {
    const f = await runtimeSamsungLegacyFixture('retirement');
    const db = f.kit.env.DB;
    const proof = {
      orgId: f.scope.orgId,
      mode: f.scope.mode,
      provider: 'samsung' as const,
      accountId: f.scope.accountId,
      accountRevision: f.scope.accountRevision,
      credentialKeysetCommitment: f.scope.credentialKeysetCommitment,
      projectionReleaseId: f.scope.providerReleaseId,
      instanceId: f.instanceId,
      operationId: f.operationId,
      version: f.version,
      claimHash: await walletClaimHash(f.claimHandle),
      refHash: f.refHash,
    };
    expect(await readWalletProviderRetirementCredentials(f.kit.ctx, proof)).toMatchObject({
      provider: 'samsung',
      accountId: proof.accountId,
      revision: proof.accountRevision,
    });
    expect(
      await readWalletProviderRetirementCredentials(f.kit.ctx, {
        ...proof,
        refHash: '0'.repeat(64),
      }),
    ).toBeNull();
    expect(await findRetirementAccount(db, proof, f.kit.clock.now() + 120_000)).toBeNull();

    const trigger = await first<{ sql: string }>(
      db,
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
      ['wallet_provider_projection_evidence_history_no_update'],
    );
    const triggerSql = trigger?.sql;
    const candidateId = f.samsungRelease?.candidateId;
    if (!triggerSql || !candidateId) throw new Error('Missing Samsung provenance fixture');
    const replaceEvidenceCountry = async (country: string) => {
      await batch(db, [
        stmt(db, 'DROP TRIGGER wallet_provider_projection_evidence_history_no_update'),
        stmt(
          db,
          'UPDATE wallet_provider_projection_evidence_history SET country_code = ? WHERE candidate_id = ?',
          [country, candidateId],
        ),
        stmt(db, triggerSql),
      ]);
    };
    await replaceEvidenceCountry('ZZ');
    expect(await readWalletProviderRetirementCredentials(f.kit.ctx, proof)).toBeNull();
    await replaceEvidenceCountry('GB');
    expect(await readWalletProviderRetirementCredentials(f.kit.ctx, proof)).not.toBeNull();

    const seam = interveneAtD1(
      db,
      {
        method: 'first',
        sql: /FROM wallet_provider_accounts a JOIN wallet_provider_credentials c/,
        when: 'before',
      },
      async () => {
        await run(db, 'UPDATE passes SET revision = revision + 1 WHERE id = ?', [f.pass.id]);
      },
    );
    const ctx = { ...f.kit.ctx, env: { ...f.kit.ctx.env, DB: seam.db } };
    expect(await readWalletProviderRetirementCredentials(ctx, proof)).toBeNull();
    expect(seam.hits()).toBe(1);
  }, 60_000);

  it('inactivates only the historical Google object authorized by the exact claimed generation', async () => {
    const f = await runtimeGoogleLegacyFixture();
    const identity = {
      tenantId: f.pass.orgId,
      mode: f.pass.mode,
      passId: f.pass.id,
      releaseId: f.releaseId,
      credentialGeneration: f.credentialGeneration,
    };
    const old = await googleObjectIds(
      f.verification.issuerId,
      f.verification.objectIdHmacKey,
      identity,
    );
    const next = await googleObjectIds(f.verification.issuerId, f.verification.objectIdHmacKey, {
      ...identity,
      credentialGeneration: identity.credentialGeneration + 1,
    });
    const calls: { url: string; method: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      const method = init?.method ?? 'GET';
      calls.push({
        url: target,
        method,
        body: method === 'PATCH' ? JSON.parse(String(init?.body)) : null,
      });
      if (target === 'https://oauth2.googleapis.com/token')
        return Response.json({
          access_token: 'ya29.fixture-token',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      if (method === 'GET') return Response.json({ id: old.objectId, classId: old.classId });
      return new Response('private provider response', { status: 200 });
    });
    const retirement: WalletRetirementClaim = {
      instanceId: f.instanceId,
      operationId: f.operationId,
      version: 1,
      claimHandle: f.claimHandle,
    };
    const input = {
      releaseId: f.releaseId,
      passId: f.pass.id,
      credentialGeneration: f.credentialGeneration,
      retirement,
      onProviderResponse: f.onProviderResponse,
    };
    await expect(
      inactivateGoogleRuntimeObject(f.kit.ctx, f.scope, {
        ...input,
        credentialGeneration: f.credentialGeneration + 1,
      }),
    ).rejects.toMatchObject({ code: 'account_unavailable' });
    await expect(
      inactivateGoogleRuntimeObject(f.kit.ctx, f.scope, {
        ...input,
        retirement: { ...retirement, instanceId: 'other-instance' },
      }),
    ).rejects.toMatchObject({ code: 'account_unavailable' });
    expect(calls).toEqual([]);
    await inactivateGoogleRuntimeObject(f.kit.ctx, f.scope, input);
    expect(next.objectId).not.toBe(old.objectId);
    expect(calls).toEqual([
      expect.objectContaining({ url: 'https://oauth2.googleapis.com/token', method: 'POST' }),
      expect.objectContaining({
        url: `https://walletobjects.googleapis.com/walletobjects/v1/genericObject/${old.objectId}`,
        method: 'GET',
      }),
      expect.objectContaining({
        url: `https://walletobjects.googleapis.com/walletobjects/v1/genericObject/${old.objectId}`,
        method: 'PATCH',
        body: { state: 'INACTIVE' },
      }),
    ]);
    expect(JSON.stringify(f.responses)).not.toContain('private provider response');
    f.kit.clock.advance(120_001);
    await expect(inactivateGoogleRuntimeObject(f.kit.ctx, f.scope, input)).rejects.toMatchObject({
      code: 'account_unavailable',
    });
    expect(calls).toHaveLength(3);
  }, 30_000);

  it('marks a changed keyset after a Google OAuth request as ambiguous and stops before object access', async () => {
    const f = await runtimeGoogleLegacyFixture();
    const replacement = await credentialRefKeysetCommitment({ ...f.kit.env, KEK_V1: alternateKek });
    const fetcher = vi.fn(async () => {
      await replaceTestKeyset(f.kit.env.DB, replacement);
      return Response.json({
        access_token: 'ya29.fixture-token',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    });
    vi.stubGlobal('fetch', fetcher);
    await expect(
      inactivateGoogleRuntimeObject(f.kit.ctx, f.scope, {
        releaseId: f.releaseId,
        passId: f.pass.id,
        credentialGeneration: f.credentialGeneration,
        retirement: {
          instanceId: f.instanceId,
          operationId: f.operationId,
          version: 1,
          claimHandle: f.claimHandle,
        },
        onProviderResponse: f.onProviderResponse,
      }),
    ).rejects.toMatchObject({ code: 'account_unavailable', ambiguous: true });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(f.responses).toHaveLength(0);
  }, 30_000);

  it('allows only the exact claimed Samsung revoke and captures its response encrypted', async () => {
    const f = await runtimeSamsungLegacyFixture('retirement');
    const retirement: WalletRetirementClaim = {
      instanceId: f.instanceId,
      operationId: f.operationId,
      version: f.version,
      claimHandle: f.claimHandle,
    };
    const calls: { url: string; method: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? '',
        body: JSON.parse(String(init?.body)),
      });
      return new Response('private provider response', { status: 200 });
    });
    const attempts: { scope: WalletRuntimeScope; claim: WalletRetirementClaim; ref: string }[] = [
      { scope: { ...f.scope, orgId: 'other-org' }, claim: retirement, ref: f.refId },
      { scope: { ...f.scope, mode: 'test' }, claim: retirement, ref: f.refId },
      { scope: { ...f.scope, accountId: 'other-account' }, claim: retirement, ref: f.refId },
      {
        scope: { ...f.scope, accountRevision: f.scope.accountRevision + 1 },
        claim: retirement,
        ref: f.refId,
      },
      {
        scope: { ...f.scope, providerReleaseId: 'other-release' },
        claim: retirement,
        ref: f.refId,
      },
      {
        scope: { ...f.scope, providerIdentityHash: '0'.repeat(64) },
        claim: retirement,
        ref: f.refId,
      },
      {
        scope: { ...f.scope, credentialKeysetCommitment: '0'.repeat(64) },
        claim: retirement,
        ref: f.refId,
      },
      { scope: f.scope, claim: { ...retirement, instanceId: 'other-instance' }, ref: f.refId },
      { scope: f.scope, claim: { ...retirement, operationId: 'other-operation' }, ref: f.refId },
      { scope: f.scope, claim: { ...retirement, version: retirement.version + 1 }, ref: f.refId },
      { scope: f.scope, claim: { ...retirement, claimHandle: 'a'.repeat(43) }, ref: f.refId },
      { scope: f.scope, claim: retirement, ref: 'z'.repeat(32) },
    ];
    for (const attempt of attempts) {
      await expect(
        sendSamsungRuntimeUpdate(f.kit.ctx, attempt.scope, {
          cc2: 'GB',
          type: 'loyalty',
          refId: attempt.ref,
          state: 'DELETED',
          attempt: 1,
          retirement: attempt.claim,
          onProviderResponse: f.onProviderResponse,
        }),
      ).rejects.toMatchObject({ code: 'account_unavailable' });
    }
    expect(calls).toHaveLength(0);
    expect(
      await sendSamsungRuntimeUpdate(f.kit.ctx, f.scope, {
        cc2: 'GB',
        type: 'loyalty',
        refId: f.refId,
        state: 'DELETED',
        attempt: 1,
        retirement,
        onProviderResponse: f.onProviderResponse,
      }),
    ).toBeUndefined();
    expect(calls).toEqual([
      {
        url: `https://tsapi-card.walletsvc.samsung.com/GB/wltex/cards/${f.samsung.cardId}/updates`,
        method: 'POST',
        body: { card: { type: 'loyalty', data: [{ refId: f.refId, state: 'DELETED' }] } },
      },
    ]);
    const [captured] = await f.readResponses();
    expect(captured).toMatchObject({ stage: 'samsung-update', method: 'POST', status: 200 });
    expect(new TextDecoder().decode(fromBase64(captured!.body))).toBe('private provider response');
    expect(JSON.stringify(f.responses)).not.toContain('private provider response');
    expect(JSON.stringify(f.responses)).not.toContain(f.samsung.partnerPrivateKeyPem);
    f.kit.clock.advance(120_001);
    await expect(
      sendSamsungRuntimeUpdate(f.kit.ctx, f.scope, {
        cc2: 'GB',
        type: 'loyalty',
        refId: f.refId,
        state: 'DELETED',
        attempt: 1,
        retirement,
        onProviderResponse: f.onProviderResponse,
      }),
    ).rejects.toMatchObject({ code: 'account_unavailable' });
    expect(calls).toHaveLength(1);
  }, 30_000);

  it('fails closed when the original singleton disappears before a retirement request', async () => {
    const f = await runtimeSamsungLegacyFixture('retirement');
    await run(f.kit.env.DB, 'DROP TRIGGER credential_ref_keyset_no_delete');
    await run(f.kit.env.DB, 'DELETE FROM credential_ref_keyset WHERE id = 1');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(
      sendSamsungRuntimeUpdate(f.kit.ctx, f.scope, {
        cc2: 'GB',
        type: 'loyalty',
        refId: f.refId,
        state: 'DELETED',
        attempt: 1,
        retirement: {
          instanceId: f.instanceId,
          operationId: f.operationId,
          version: f.version,
          claimHandle: f.claimHandle,
        },
        onProviderResponse: f.onProviderResponse,
      }),
    ).rejects.toMatchObject({ code: 'account_unavailable', ambiguous: false });
    await expect(
      getWalletProviderReadiness(f.kit.ctx, {
        orgId: f.pass.orgId,
        mode: f.pass.mode,
        provider: 'samsung',
      }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(f.responses).toHaveLength(0);
  }, 30_000);

  it('fences an empty-reference account creation at the final SQL transaction', async () => {
    const f = await setupWalletOfferKit({ google: 'absent', samsung: 'absent' });
    const scope = { orgId: f.pass.orgId, mode: f.pass.mode, provider: 'google' as const };
    const authority = await tenantAuthorityOf(
      f.kit.ctx,
      f.auth,
      scope.orgId,
      'integrations:manage',
    );
    if (authority.kind !== 'session') throw new Error('Missing session authority');
    const accountId = f.kit.ctx.ids.id();
    const credentialId = f.kit.ctx.ids.id();
    const envelope = await encryptSecret(
      await loadKekRing(f.kit.env),
      '{}',
      credentialAad(
        credentialId,
        scope.orgId,
        `wallet-provider:${accountId}:${scope.mode}:${scope.provider}`,
      ),
    );
    const replacement = await credentialRefKeysetCommitment({ ...f.kit.env, KEK_V1: alternateKek });
    await replaceTestKeyset(f.kit.env.DB, replacement);
    expect(
      await saveAccountConfiguration(f.kit.ctx, authority, scope, {
        accountId,
        credentialId,
        envelope,
        eventId: f.kit.ctx.ids.id(),
        isNew: true,
        expectedRevision: 0,
        credentialKeysetCommitment: f.credentialKeysetCommitment,
      }),
    ).toBe(false);
    expect(
      await first(f.kit.env.DB, 'SELECT id FROM wallet_provider_accounts WHERE id = ?', [
        accountId,
      ]),
    ).toBeNull();
    expect(
      await first(f.kit.env.DB, 'SELECT id FROM wallet_provider_credentials WHERE id = ?', [
        credentialId,
      ]),
    ).toBeNull();
  }, 30_000);

  it('does not adopt old claimed identities or rotate their account after an audited keyset change', async () => {
    const f = await runtimeSamsungLegacyFixture('retirement');
    const proof = {
      orgId: f.scope.orgId,
      mode: f.scope.mode,
      provider: 'samsung' as const,
      accountId: f.scope.accountId,
      accountRevision: f.scope.accountRevision,
      credentialKeysetCommitment: f.scope.credentialKeysetCommitment,
      projectionReleaseId: f.scope.providerReleaseId,
      instanceId: f.instanceId,
      operationId: f.operationId,
      version: f.version,
      claimHash: await walletClaimHash(f.claimHandle),
      refHash: f.refHash,
    };
    expect(await findRetirementAccount(f.kit.env.DB, proof, f.kit.clock.now())).not.toBeNull();
    const replacement = await credentialRefKeysetCommitment({ ...f.kit.env, KEK_V1: alternateKek });
    await run(f.kit.env.DB, 'DROP TRIGGER credential_ref_keyset_no_update');
    await run(f.kit.env.DB, 'UPDATE credential_ref_keyset SET commitment = ? WHERE id = 1', [
      replacement,
    ]);
    f.kit.env.KEK_V1 = alternateKek;
    expect(
      await findRetirementAccount(
        f.kit.env.DB,
        {
          ...proof,
          credentialKeysetCommitment: replacement,
        },
        f.kit.clock.now(),
      ),
    ).toBeNull();
    await expect(
      getWalletProviderReadiness(f.kit.ctx, {
        orgId: f.pass.orgId,
        mode: f.pass.mode,
        provider: 'samsung',
      }),
    ).rejects.toMatchObject({ code: 'WALLET_CREDENTIALS_UNAVAILABLE' });
    const before = await first<{ n: number }>(
      f.kit.env.DB,
      'SELECT COUNT(*) AS n FROM wallet_provider_credentials WHERE account_id = ?',
      [f.scope.accountId],
    );
    await expect(
      configureWalletProviderAccount(f.kit.ctx, f.auth, {
        orgId: f.pass.orgId,
        mode: f.pass.mode,
        provider: 'samsung',
        expectedRevision: f.scope.accountRevision,
        credentials: f.samsung,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_CREDENTIALS_UNAVAILABLE' });
    expect(
      await first(
        f.kit.env.DB,
        'SELECT COUNT(*) AS n FROM wallet_provider_credentials WHERE account_id = ?',
        [f.scope.accountId],
      ),
    ).toEqual(before);
  }, 30_000);

  it('requires promoted-ref account selection to retain the captured keyset', async () => {
    const f = await runtimeSamsungLegacyFixture('refresh');
    const proof = {
      orgId: f.scope.orgId,
      mode: f.scope.mode,
      accountId: f.scope.accountId,
      accountRevision: f.scope.accountRevision,
      credentialKeysetCommitment: f.scope.credentialKeysetCommitment,
      projectionReleaseId: f.scope.providerReleaseId,
      instanceId: f.instanceId,
      refHash: f.refHash,
      operationVersion: f.version,
    };
    expect(
      await findSamsungPromotedRefreshAccount(f.kit.env.DB, proof, f.kit.clock.now()),
    ).not.toBeNull();
    expect(
      await findSamsungPromotedRefreshAccount(
        f.kit.env.DB,
        {
          ...proof,
          credentialKeysetCommitment: '0'.repeat(64),
        },
        f.kit.clock.now(),
      ),
    ).toBeNull();
  }, 30_000);

  it('uses one captured KEK snapshot when the caller changes its environment after the request starts', async () => {
    const f = await runtimeSamsungLegacyFixture('retirement');
    const originalKek = f.kit.env.KEK_V1;
    const sink = vi.fn(async () => undefined);
    vi.stubGlobal('fetch', async () => new Response('provider response', { status: 200 }));
    const request = sendSamsungRuntimeUpdate(f.kit.ctx, f.scope, {
      cc2: 'GB',
      type: 'loyalty',
      refId: f.refId,
      state: 'DELETED',
      attempt: 1,
      retirement: {
        instanceId: f.instanceId,
        operationId: f.operationId,
        version: f.version,
        claimHandle: f.claimHandle,
      },
      onProviderResponse: sink,
    });
    f.kit.env.KEK_V1 = alternateKek;
    try {
      await expect(request).resolves.toBeUndefined();
    } finally {
      f.kit.env.KEK_V1 = originalKek;
    }
    expect(sink).toHaveBeenCalledOnce();
  }, 30_000);

  it('treats keyset loss after sending a retirement request as ambiguous without emitting a response', async () => {
    const f = await runtimeSamsungLegacyFixture('retirement');
    const replacement = await credentialRefKeysetCommitment({ ...f.kit.env, KEK_V1: alternateKek });
    const fetcher = vi.fn(async () => {
      await replaceTestKeyset(f.kit.env.DB, replacement);
      return new Response('private provider response', { status: 200 });
    });
    vi.stubGlobal('fetch', fetcher);
    await expect(
      sendSamsungRuntimeUpdate(f.kit.ctx, f.scope, {
        cc2: 'GB',
        type: 'loyalty',
        refId: f.refId,
        state: 'DELETED',
        attempt: 1,
        retirement: {
          instanceId: f.instanceId,
          operationId: f.operationId,
          version: f.version,
          claimHandle: f.claimHandle,
        },
        onProviderResponse: f.onProviderResponse,
      }),
    ).rejects.toMatchObject({ code: 'account_unavailable', ambiguous: true });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(f.responses).toHaveLength(0);
  }, 30_000);

  it('rechecks the keyset after reading the response stream and before invoking its sink', async () => {
    const f = await runtimeSamsungLegacyFixture('retirement');
    const replacement = await credentialRefKeysetCommitment({ ...f.kit.env, KEK_V1: alternateKek });
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              async pull(controller) {
                await replaceTestKeyset(f.kit.env.DB, replacement);
                controller.enqueue(new TextEncoder().encode('private provider response'));
                controller.close();
              },
            },
            { highWaterMark: 0 },
          ),
          { status: 200 },
        ),
    );
    await expect(
      sendSamsungRuntimeUpdate(f.kit.ctx, f.scope, {
        cc2: 'GB',
        type: 'loyalty',
        refId: f.refId,
        state: 'DELETED',
        attempt: 1,
        retirement: {
          instanceId: f.instanceId,
          operationId: f.operationId,
          version: f.version,
          claimHandle: f.claimHandle,
        },
        onProviderResponse: f.onProviderResponse,
      }),
    ).rejects.toMatchObject({ code: 'account_unavailable', ambiguous: true });
    expect(f.responses).toHaveLength(0);
  }, 30_000);

  it('retains a failure response while preserving sanitized provider status', async () => {
    const f = await runtimeSamsungLegacyFixture('retirement');
    vi.stubGlobal('fetch', async () => new Response('private provider failure', { status: 503 }));
    let failure: unknown;
    try {
      await sendSamsungRuntimeUpdate(f.kit.ctx, f.scope, {
        cc2: 'GB',
        type: 'loyalty',
        refId: f.refId,
        state: 'DELETED',
        attempt: 1,
        retirement: {
          instanceId: f.instanceId,
          operationId: f.operationId,
          version: f.version,
          claimHandle: f.claimHandle,
        },
        onProviderResponse: f.onProviderResponse,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SamsungNotificationError);
    expect(failure).toMatchObject({ kind: 'unavailable', status: 503, ambiguous: true });
    expect(String(failure)).not.toContain('private provider failure');
    expect((await f.readResponses())[0]).toMatchObject({ stage: 'samsung-update', status: 503 });
    expect(JSON.stringify(f.responses)).not.toContain('private provider failure');
  }, 30_000);

  it('marks an oversize response or failed encrypted sink as ambiguous', async () => {
    const f = await runtimeSamsungLegacyFixture('retirement');
    const retirement = {
      instanceId: f.instanceId,
      operationId: f.operationId,
      version: f.version,
      claimHandle: f.claimHandle,
    };
    const cases = [
      { bytes: new Uint8Array(64 * 1024 + 1), sink: f.onProviderResponse },
      {
        bytes: new Uint8Array([1]),
        sink: async () => {
          throw new Error('private storage failure');
        },
      },
    ];
    for (const entry of cases) {
      vi.stubGlobal(
        'fetch',
        async () => new Response(entry.bytes as BufferSource, { status: 200 }),
      );
      let failure: unknown;
      try {
        await sendSamsungRuntimeUpdate(f.kit.ctx, f.scope, {
          cc2: 'GB',
          type: 'loyalty',
          refId: f.refId,
          state: 'DELETED',
          attempt: 1,
          retirement,
          onProviderResponse: entry.sink,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: 'provider_failure', ambiguous: true });
      expect(String(failure)).not.toContain('private storage failure');
    }
    expect(f.responses).toHaveLength(0);
  }, 30_000);

  it('authenticates and renders only an already-promoted Samsung reference', async () => {
    const f = await runtimeSamsungLegacyFixture('refresh');
    await expect(assertWalletRuntimeAccount(f.kit.ctx, f.scope, 'samsung')).rejects.toMatchObject({
      code: 'account_unavailable',
    });
    const seen = new Set<string>();
    const claimReplay = async (key: string) => {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    };
    const request = await f.request('?cc2=GB');
    const refresh = { instanceId: f.instanceId, refHash: f.refHash, operationVersion: f.version };
    const invalid = [
      { scope: { ...f.scope, orgId: 'other-org' }, refresh },
      { scope: { ...f.scope, mode: 'test' as const }, refresh },
      { scope: { ...f.scope, accountId: 'other-account' }, refresh },
      { scope: { ...f.scope, accountRevision: f.scope.accountRevision + 1 }, refresh },
      { scope: { ...f.scope, providerReleaseId: 'other-release' }, refresh },
      { scope: f.scope, refresh: { ...refresh, instanceId: 'other-instance' } },
      { scope: f.scope, refresh: { ...refresh, operationVersion: refresh.operationVersion + 1 } },
    ];
    for (const item of invalid) {
      await expect(
        verifySamsungRuntimeRequest(f.kit.ctx, item.scope, {
          request,
          refId: f.refId,
          method: 'GET',
          refresh: item.refresh,
          claimReplay,
        }),
      ).rejects.toMatchObject({ code: 'account_unavailable' });
    }
    expect(seen.size).toBe(0);
    const handle = await verifySamsungRuntimeRequest(f.kit.ctx, f.scope, {
      request,
      refId: f.refId,
      method: 'GET',
      refresh,
      claimReplay,
    });
    expect(handle).toMatchObject({ refId: f.refId, method: 'GET', queryBound: true });
    const result = await samsungRuntimeCardDataResponse(f.kit.ctx, f.scope, handle, f.projection);
    expect(result.cdata).toBeTruthy();
    expect(result.cdata).not.toContain('Confidential member value');
    expect(result.cdata).not.toContain(f.samsung.partnerPrivateKeyPem);
    await expect(
      samsungRuntimeCardDataResponse(f.kit.ctx, f.scope, handle, f.projection),
    ).rejects.toMatchObject({ code: 'provider_failure' });
    await expect(
      verifySamsungRuntimeRequest(f.kit.ctx, f.scope, {
        request,
        refId: f.refId,
        method: 'GET',
        refresh,
        claimReplay,
      }),
    ).rejects.toBeInstanceOf(SamsungTokenError);
  }, 30_000);

  it('pins Samsung verification handles and rejects a keyset change during replay reservation', async () => {
    const f = await runtimeSamsungLegacyFixture('refresh');
    const request = await f.request();
    const refresh = { instanceId: f.instanceId, refHash: f.refHash, operationVersion: f.version };
    const handle = await verifySamsungRuntimeRequest(f.kit.ctx, f.scope, {
      request,
      refId: f.refId,
      method: 'GET',
      refresh,
      claimReplay: async () => true,
    });
    await expect(
      samsungRuntimeCardDataResponse(
        f.kit.ctx,
        {
          ...f.scope,
          credentialKeysetCommitment: '0'.repeat(64),
        },
        handle,
        f.projection,
      ),
    ).rejects.toMatchObject({ code: 'account_unavailable' });
    const replacement = await credentialRefKeysetCommitment({ ...f.kit.env, KEK_V1: alternateKek });
    let replayCalled = false;
    await expect(
      verifySamsungRuntimeRequest(f.kit.ctx, f.scope, {
        request,
        refId: f.refId,
        method: 'GET',
        refresh,
        claimReplay: async () => {
          replayCalled = true;
          await replaceTestKeyset(f.kit.env.DB, replacement);
          return true;
        },
      }),
    ).rejects.toMatchObject({ code: 'account_unavailable', ambiguous: false });
    expect(replayCalled).toBe(true);
  }, 30_000);

  it('rejects unpromoted, wrong-reference and stale-pass refreshes', async () => {
    const unpromoted = await runtimeSamsungLegacyFixture('refresh', false);
    const denied = await unpromoted.request();
    let replayCalled = false;
    const claimReplay = async () => {
      replayCalled = true;
      return true;
    };
    await expect(
      verifySamsungRuntimeRequest(unpromoted.kit.ctx, unpromoted.scope, {
        request: denied,
        refId: unpromoted.refId,
        method: 'GET',
        refresh: {
          instanceId: unpromoted.instanceId,
          refHash: unpromoted.refHash,
          operationVersion: unpromoted.version,
        },
        claimReplay,
      }),
    ).rejects.toMatchObject({ code: 'account_unavailable' });
    expect(replayCalled).toBe(false);
    const f = await runtimeSamsungLegacyFixture('refresh');
    const request = await f.request();
    const refresh = { instanceId: f.instanceId, refHash: f.refHash, operationVersion: f.version };
    await expect(
      verifySamsungRuntimeRequest(f.kit.ctx, f.scope, {
        request,
        refId: f.refId,
        method: 'GET',
        refresh: { ...refresh, refHash: '0'.repeat(64) },
        claimReplay,
      }),
    ).rejects.toMatchObject({ code: 'account_unavailable' });
    const handle = await verifySamsungRuntimeRequest(f.kit.ctx, f.scope, {
      request,
      refId: f.refId,
      method: 'GET',
      refresh,
      claimReplay,
    });
    await run(f.kit.env.DB, 'UPDATE passes SET revision = revision + 1 WHERE id = ?', [f.pass.id]);
    await expect(
      samsungRuntimeCardDataResponse(f.kit.ctx, f.scope, handle, f.projection),
    ).rejects.toMatchObject({ code: 'account_unavailable' });
  }, 30_000);

  it('rejects retired references and expires cached provider card proof', async () => {
    const retired = await runtimeSamsungLegacyFixture('refresh');
    await run(
      retired.kit.env.DB,
      'UPDATE wallet_samsung_fetch_refs SET retired_at = ? WHERE id = ?',
      [retired.kit.clock.now(), retired.refRow],
    );
    let called = false;
    const claimReplay = async () => {
      called = true;
      return true;
    };
    await expect(
      verifySamsungRuntimeRequest(retired.kit.ctx, retired.scope, {
        request: await retired.request(),
        refId: retired.refId,
        method: 'GET',
        refresh: {
          instanceId: retired.instanceId,
          refHash: retired.refHash,
          operationVersion: retired.version,
        },
        claimReplay,
      }),
    ).rejects.toMatchObject({ code: 'account_unavailable' });
    expect(called).toBe(false);
    const f = await runtimeSamsungLegacyFixture('refresh');
    f.kit.clock.advance(300_001);
    await expect(
      verifySamsungRuntimeRequest(f.kit.ctx, f.scope, {
        request: await f.request(),
        refId: f.refId,
        method: 'GET',
        refresh: { instanceId: f.instanceId, refHash: f.refHash, operationVersion: f.version },
        claimReplay,
      }),
    ).rejects.toMatchObject({ code: 'account_unavailable' });
    expect(called).toBe(false);
  }, 30_000);

  it('authenticates a historical tombstone after rotation and revocation without a signing key', async () => {
    const f = await setupWalletOfferKit({ google: 'absent', samsung: 'published' });
    const credentialKeysetCommitment = f.credentialKeysetCommitment;
    expect(await requireCredentialRefKeyset(f.kit.env.DB, f.kit.env)).toBe(
      credentialKeysetCommitment,
    );
    const snapshot = await readWalletPassSnapshot(f.kit.env.DB, {
      orgId: f.pass.orgId,
      mode: f.pass.mode,
      passId: f.pass.id,
      credentialKeysetCommitment,
    });
    if (!snapshot?.issuingReleaseId || !f.samsungRelease?.candidateId)
      throw new Error('Missing release fixture');
    const approved = await getApprovedProjection(
      f.kit.ctx,
      {
        orgId: f.pass.orgId,
        mode: f.pass.mode,
        provider: 'samsung',
        templateId: snapshot.templateId,
        templateVersion: snapshot.templateVersion,
        appleReleaseId: snapshot.issuingReleaseId,
      },
      { credentialKeysetCommitment },
    );
    if (!approved) throw new Error('Missing approved release fixture');
    const refId = 'abcdefghijklmnopqrstuvwxABCDEFGH';
    const refHash = await sha256Hex(refId);
    const scope = {
      orgId: f.pass.orgId,
      mode: f.pass.mode,
      accountId: approved.release.accountId,
      accountRevision: approved.release.accountRevision,
      refHash,
      credentialKeysetCommitment,
    };
    await run(
      f.kit.env.DB,
      `INSERT INTO wallet_samsung_tombstones
      (ref_hash, org_id, mode, account_id, account_revision, candidate_id, release_id, provider_identity_hash,
       retired_at, credential_keyset_commitment)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        refHash,
        scope.orgId,
        scope.mode,
        scope.accountId,
        scope.accountRevision,
        f.samsungRelease.candidateId,
        approved.release.id,
        approved.release.providerIdentityHash,
        f.kit.clock.now(),
        scope.credentialKeysetCommitment,
      ],
    );
    const rotated = await configureWalletProviderAccount(f.kit.ctx, f.auth, {
      orgId: scope.orgId,
      mode: scope.mode,
      provider: 'samsung',
      expectedRevision: scope.accountRevision,
      credentials: f.samsung,
    });
    await revokeWalletProviderAccount(f.kit.ctx, f.auth, {
      orgId: scope.orgId,
      mode: scope.mode,
      provider: 'samsung',
      expectedRevision: rotated.revision,
    });
    const path = `/wallet/v1/samsung/cards/${f.samsung.cardId}/${refId}`;
    const key = (await importPKCS8(f.samsung.partnerPrivateKeyPem, 'RS256')) as CryptoKey;
    const token = await new CompactSign(
      new TextEncoder().encode(JSON.stringify({ API: { method: 'GET', path }, refId })),
    )
      .setProtectedHeader({
        alg: 'RS256',
        cty: 'AUTH',
        ver: '3',
        certificateId: f.samsung.certificateId,
        partnerId: f.samsung.partnerId,
        utc: f.kit.clock.now(),
      })
      .sign(key);
    const request = new Request(`https://example.test${path}`, {
      headers: { Authorization: `Bearer ${token}`, 'x-request-id': 'tombstone-test' },
    });
    const seen = new Set<string>();
    const claimReplay = async (hash: string) => {
      if (seen.has(hash)) return false;
      seen.add(hash);
      return true;
    };
    await expect(
      verifySamsungTombstoneRuntimeRequest(f.kit.ctx, scope, { request, refId, claimReplay }),
    ).resolves.toBeUndefined();
    await expect(
      verifySamsungTombstoneRuntimeRequest(f.kit.ctx, scope, { request, refId, claimReplay }),
    ).rejects.toBeInstanceOf(SamsungTokenError);
    await expect(
      verifySamsungTombstoneRuntimeRequest(f.kit.ctx, scope, {
        request,
        refId,
        claimReplay: async () => {
          throw new Error('private database detail');
        },
      }),
    ).rejects.toBeInstanceOf(SamsungReplayStoreError);
    const replacement = await credentialRefKeysetCommitment({ ...f.kit.env, KEK_V1: alternateKek });
    await expect(
      verifySamsungTombstoneRuntimeRequest(f.kit.ctx, scope, {
        request,
        refId,
        claimReplay: async () => {
          await replaceTestKeyset(f.kit.env.DB, replacement);
          return true;
        },
      }),
    ).rejects.toMatchObject({ code: 'account_unavailable' });
  }, 30_000);
});
