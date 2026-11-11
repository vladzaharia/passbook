import { beforeAll, describe, expect, it } from 'vitest';
import {
  fixtures,
  makeEnv,
  makeOrg,
  makeSession,
  makeUser,
} from '../../../../test/helpers/index.ts';
import type { GoogleWalletCredentials } from '../../../shared/contracts/wallet-providers.ts';
import { ManualClock } from '../../platform/clock.ts';
import {
  credentialAad,
  decryptSecretText,
  encryptSecret,
  loadKekRing,
} from '../../platform/crypto.ts';
import { all, batch, first, run, stmt } from '../../platform/db.ts';
import { fromBase64Url, sha256Hex } from '../../platform/ids.ts';
import { createServiceContext, type ServiceContext } from '../../platform/service-context.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { makeRsaPem } from '../identities/push-key-fixtures.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { startCredentialTransfer } from '../passes/credential-transfer.ts';
import {
  configureWalletProviderAccount,
  readConfiguredWalletProviderCredentials,
  readGoogleCallbackVerification,
} from './account-service.ts';
import {
  ensureSamsungFetchRef,
  getSamsungRefreshTarget,
  retireExpiredUnpromotedRef,
} from './callbacks-ref.ts';
import { GOOGLE_WALLET_SCOPE } from './google-credentials.ts';
import { googleClassId, googleObjectIds } from './google-ids.ts';
import {
  completeWalletOperation,
  newWalletClaimHandle,
  readWalletPassSnapshot,
  walletClaimHash,
} from './instance.ts';
import { setupWalletOfferKit } from './offers-test-fixtures.ts';
import { projectionPolicy } from './projection-contract.ts';
import { approveProjectionCandidate, createProjectionCandidate } from './projection-service.ts';
import { findAccount } from './repo-accounts.ts';
import {
  seedHistoricalProviderInstance,
  seedHistoricalSamsungRef,
} from './runtime-historical-fixtures.ts';
import { createSamsungRefId } from './samsung.ts';

const KEK_V1 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const KEK_V2 = btoa(String.fromCharCode(...new Uint8Array(32).fill(78)));

let google: GoogleWalletCredentials;
let rotatedGoogle: GoogleWalletCredentials;

beforeAll(async () => {
  const [privateKeyPem, rotatedPem] = await Promise.all([makeRsaPem(), makeRsaPem()]);
  google = {
    issuerId: '33880000000223344',
    serviceAccountEmail: 'wallet@example.iam.gserviceaccount.com',
    privateKeyPem,
    scopes: [GOOGLE_WALLET_SCOPE],
  };
  rotatedGoogle = { ...google, privateKeyPem: rotatedPem };
}, 30_000);

async function googleFixture() {
  const env = await makeEnv({ KEK_V1, KEK_V2: undefined, KEK_V3: undefined });
  const clock = new ManualClock(Date.now());
  const f = fixtures(env, clock);
  const org = await makeOrg(f);
  const user = await makeUser(f);
  const now = clock.now();
  const invitationId = f.ids.id();
  await run(
    env.DB,
    `INSERT INTO org_invitations
    (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      invitationId,
      org.id,
      user.primaryEmail,
      '["org_admin"]',
      f.ids.token(),
      now,
      now + 3_600_000,
      now,
    ],
  );
  await run(
    env.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`,
    [f.ids.id(), org.id, user.id, invitationId, '["org_admin"]', now],
  );
  const session = await makeSession(f, { userId: user.id });
  const auth = await createSessionStore(env, clock).resolve(session.cookieValue);
  if (!auth) throw new Error('Session fixture did not resolve');
  return { env, clock, auth, orgId: org.id, google, rotatedGoogle };
}

async function googleSnapshot(
  ctx: ServiceContext,
  orgId: string,
  accountId: string,
  accountRevision: number,
  credentialKeysetCommitment: string,
) {
  const snapshot = await readConfiguredWalletProviderCredentials(
    ctx,
    { orgId, mode: 'live', provider: 'google' },
    { accountId, accountRevision, credentialKeysetCommitment },
  );
  if (snapshot?.provider !== 'google') throw new Error('Missing Google credential snapshot');
  return snapshot;
}

/** Build a pre-gate Samsung retirement without simulating provider publication or network responses. */
async function historicalSamsung(promoted = true) {
  const f = await setupWalletOfferKit({ google: 'absent', samsung: 'configured' });
  const { kit, pass, apple } = f;
  const db = kit.env.DB;
  const scope = { orgId: pass.orgId, mode: pass.mode, provider: 'samsung' as const };
  const credentialKeysetCommitment = await ensureCredentialRefKeyset(db, kit.env);
  const account = await findAccount(db, scope);
  const passSnapshot = await readWalletPassSnapshot(db, {
    ...scope,
    passId: pass.id,
    credentialKeysetCommitment,
  });
  if (!account || !passSnapshot?.issuingReleaseId)
    throw new Error('Missing historical account or pass');

  const candidate = await createProjectionCandidate(kit.ctx, apple.authorAuth, kit.template.id, {
    ...scope,
    version: kit.template.version,
    sourceReleaseId: apple.id,
    projection: f.projection('samsung'),
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
  await f.refreshSamsungEvidence(candidate.id, candidate.candidateHash);
  // As in historicalGoogleRelease, restore the guard in the same transaction: this models a
  // previously reviewed release, not a present-day Samsung issuance authorization.
  const guard = await first<{ sql: string }>(
    db,
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'template_provider_releases_insert'",
  );
  if (!guard?.sql) throw new Error('Missing native release guard');
  const releaseId = kit.ctx.ids.id();
  const release = await batch(db, [
    stmt(db, 'DROP TRIGGER template_provider_releases_insert'),
    stmt(
      db,
      `INSERT INTO template_releases
      (id, template_id, org_id, mode, provider, generation, version, candidate_hash, content_hash,
       adapter_revision, adapter_capabilities, audience_policy_revision, source, action, candidate_id,
       approval_id, previous_release_id, rollback_of_release_id, created_by, created_at, credential_keyset_commitment)
      SELECT ?, c.template_id, c.org_id, c.mode, c.provider, 1, c.version, c.candidate_hash, c.content_hash,
        c.adapter_revision, c.adapter_capabilities, c.audience_policy_revision, 'approved', 'release',
        c.id, a.id, NULL, NULL, c.author_id, ?, c.credential_keyset_commitment
      FROM template_candidates c JOIN template_approvals a ON a.candidate_id = c.id
        AND a.candidate_hash = c.candidate_hash
      WHERE c.id = ? AND a.id = ? AND c.provider = 'samsung' AND a.reviewer_id != c.author_id
        AND c.credential_keyset_commitment = ?
        AND (c.version_author_id IS NULL OR a.reviewer_id != c.version_author_id)`,
      [releaseId, kit.clock.now(), candidate.id, approval.id, credentialKeysetCommitment],
    ),
    stmt(db, guard.sql),
  ]);
  if (release[1]?.meta.changes !== 1) throw new Error('Missing historical Samsung release');

  const now = kit.clock.now();
  const instanceId = kit.ctx.ids.id();
  const initialOperationId = kit.ctx.ids.id();
  const initial = await seedHistoricalProviderInstance(db, {
    id: instanceId,
    passId: pass.id,
    ...scope,
    credentialGeneration: passSnapshot.credentialGeneration,
    accountId: account.id,
    releaseId,
    operationId: initialOperationId,
    now,
    credentialKeysetCommitment,
    upsert: { requestHash: await sha256Hex(initialOperationId), state: 'succeeded' },
  });
  if (!initial) throw new Error('Missing historical Samsung operation');
  const refId = createSamsungRefId();
  const refRowId = kit.ctx.ids.id();
  const refHash = await sha256Hex(refId);
  const envelope = await encryptSecret(
    await loadKekRing(kit.env),
    refId,
    credentialAad(refRowId, pass.orgId, `samsung-ref|${pass.mode}|${instanceId}`),
  );
  await seedHistoricalSamsungRef(db, {
    id: refRowId,
    refHash,
    instanceId,
    createdAt: now,
    initialExpiresAt: now + (promoted ? 300_000 : 1_000),
    promotedAt: promoted ? now : null,
    envelope,
    credentialKeysetCommitment,
  });

  // Use the same historical claimed-revoke representation as runtimeSamsungLegacyFixture.
  const operationId = kit.ctx.ids.id();
  const claimHandle = newWalletClaimHandle();
  const claimHash = await walletClaimHash(claimHandle);
  const policy = projectionPolicy('samsung');
  await run(
    db,
    `INSERT INTO wallet_provider_instance_operations
    (id, instance_id, version, kind, request_hash, pass_version, pass_revision, pass_credential_generation,
     lifecycle_generation, issuing_release_id, projection_release_id, account_revision, adapter_revision,
     policy_revision, state, attempts, claim_hash, claim_expires_at, created_at, credential_keyset_commitment)
    VALUES (?, ?, 2, 'revoke', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', 1, ?, ?, ?, ?)`,
    [
      operationId,
      instanceId,
      await sha256Hex(operationId),
      passSnapshot.passVersion,
      passSnapshot.passRevision,
      passSnapshot.credentialGeneration,
      passSnapshot.lifecycleGeneration,
      passSnapshot.issuingReleaseId,
      releaseId,
      account.revision,
      policy.adapterRevision,
      policy.audiencePolicyRevision,
      claimHash,
      now + 120_000,
      now,
      credentialKeysetCommitment,
    ],
  );
  await run(
    db,
    `UPDATE wallet_provider_instances SET desired_version = 2, desired_operation_id = ?,
    lifecycle = 'revoking' WHERE id = ?`,
    [operationId, instanceId],
  );
  return {
    ...f,
    db,
    instanceId,
    refId,
    refHash,
    refRowId,
    claimHandle,
    credentialKeysetCommitment,
    refScope: {
      orgId: scope.orgId,
      mode: scope.mode,
      instanceId,
      operationVersion: 2,
      credentialKeysetCommitment,
    },
  };
}

describe('provider identity continuity across KEK rotation', () => {
  it('retains a persisted random Google HMAC and its generation-scoped IDs after removing V1', async () => {
    const f = await googleFixture();
    const initialCtx = createServiceContext(
      { ...f.env, KEK_V1, KEK_V2: undefined, KEK_V3: undefined },
      { clock: f.clock },
    );
    const scope = { orgId: f.orgId, mode: 'live' as const, provider: 'google' as const };
    const credentialKeysetCommitment = await ensureCredentialRefKeyset(
      initialCtx.env.DB,
      initialCtx.env,
    );
    const account = await configureWalletProviderAccount(initialCtx, f.auth, {
      ...scope,
      expectedRevision: 0,
      credentials: f.google,
    });
    if (!account.accountId) throw new Error('Missing Google account');
    const beforeRow = await findAccount(f.env.DB, scope);
    if (!beforeRow?.credential_id) throw new Error('Missing initial envelope');
    expect(beforeRow.kek_version).toBe(1);
    const before = await googleSnapshot(
      initialCtx,
      f.orgId,
      account.accountId,
      account.revision,
      credentialKeysetCommitment,
    );
    expect(before.objectIdHmacKey).toHaveLength(32);

    // The same KEK does not deterministically recreate the identity for another account.
    const other = await googleFixture();
    const otherCtx = createServiceContext(
      { ...other.env, KEK_V1, KEK_V2: undefined, KEK_V3: undefined },
      { clock: other.clock },
    );
    const otherAccount = await configureWalletProviderAccount(otherCtx, other.auth, {
      orgId: other.orgId,
      mode: 'live',
      provider: 'google',
      expectedRevision: 0,
      credentials: other.google,
    });
    if (!otherAccount.accountId) throw new Error('Missing second Google account');
    const otherSnapshot = await googleSnapshot(
      otherCtx,
      other.orgId,
      otherAccount.accountId,
      otherAccount.revision,
      credentialKeysetCommitment,
    );
    expect(otherSnapshot.objectIdHmacKey).not.toEqual(before.objectIdHmacKey);

    const idScope = {
      tenantId: f.orgId,
      releaseId: 'historical-release',
      passId: 'historical-pass',
      mode: 'live' as const,
      credentialGeneration: 3,
    };
    const originalIds = await googleObjectIds(
      before.credentials.issuerId,
      before.objectIdHmacKey,
      idScope,
    );
    expect(originalIds.classId).toBe(
      await googleClassId(before.credentials.issuerId, before.objectIdHmacKey, idScope),
    );
    const nextGeneration = await googleObjectIds(
      before.credentials.issuerId,
      before.objectIdHmacKey,
      { ...idScope, credentialGeneration: idScope.credentialGeneration + 1 },
    );
    expect(nextGeneration.classId).toBe(originalIds.classId);
    expect(nextGeneration.objectId).not.toBe(originalIds.objectId);

    const rolloverCtx = createServiceContext(
      { ...f.env, KEK_V1, KEK_V2, KEK_V3: undefined },
      { clock: f.clock },
    );
    const rotated = await configureWalletProviderAccount(rolloverCtx, f.auth, {
      ...scope,
      expectedRevision: account.revision,
      credentials: f.rotatedGoogle,
    });
    expect(rotated).toMatchObject({ accountId: account.accountId, revision: account.revision + 1 });
    const rotatedRow = await findAccount(f.env.DB, scope);
    if (
      !rotatedRow?.credential_id ||
      rotatedRow.kek_version !== 2 ||
      !rotatedRow.iv ||
      !rotatedRow.wrapped_dek ||
      !rotatedRow.ciphertext
    )
      throw new Error('Missing rotated envelope');
    expect(rotatedRow.kek_version).toBe(2);
    expect(rotatedRow?.credential_id).not.toBe(beforeRow.credential_id);
    expect(
      await all(
        f.env.DB,
        'SELECT kek_version FROM wallet_provider_credentials WHERE account_id = ? ORDER BY kek_version',
        [account.accountId],
      ),
    ).toEqual([{ kek_version: 1 }, { kek_version: 2 }]);

    const retiredV1Ctx = createServiceContext(
      { ...f.env, KEK_V1: '', KEK_V2, KEK_V3: undefined },
      { clock: f.clock },
    );
    const toBytes = (value: number[] | Uint8Array | ArrayBuffer) =>
      value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value);
    const stored = JSON.parse(
      await decryptSecretText(
        await loadKekRing(retiredV1Ctx.env),
        {
          kekVersion: rotatedRow.kek_version,
          iv: toBytes(rotatedRow.iv),
          wrappedDek: toBytes(rotatedRow.wrapped_dek),
          ciphertext: toBytes(rotatedRow.ciphertext),
        },
        credentialAad(
          rotatedRow.credential_id,
          f.orgId,
          `wallet-provider:${account.accountId}:live:google`,
        ),
      ),
    ) as {
      version: number;
      provider: string;
      credentials: { issuerId: string; privateKeyPem: string };
      objectIdHmacKey: string;
    };
    expect(stored).toMatchObject({
      version: 1,
      provider: 'google',
      credentials: { privateKeyPem: f.rotatedGoogle.privateKeyPem },
    });
    const recoveredKey = fromBase64Url(stored.objectIdHmacKey);
    expect(recoveredKey).toEqual(before.objectIdHmacKey);
    expect(await googleObjectIds(stored.credentials.issuerId, recoveredKey, idScope)).toEqual(
      originalIds,
    );
    await expect(
      readConfiguredWalletProviderCredentials(retiredV1Ctx, scope, {
        accountId: account.accountId,
        accountRevision: rotated.revision,
        credentialKeysetCommitment,
      }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE' });
    await expect(
      readGoogleCallbackVerification(retiredV1Ctx, {
        ...scope,
        accountId: account.accountId,
        accountRevision: rotated.revision,
        credentialKeysetCommitment,
      }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE' });
    await expect(
      configureWalletProviderAccount(retiredV1Ctx, f.auth, {
        ...scope,
        expectedRevision: rotated.revision,
        credentials: f.google,
      }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE' });
    expect(await findAccount(f.env.DB, scope)).toEqual(rotatedRow);
    const after = await googleSnapshot(
      rolloverCtx,
      f.orgId,
      account.accountId,
      rotated.revision,
      credentialKeysetCommitment,
    );
    expect(after.objectIdHmacKey).toEqual(before.objectIdHmacKey);
    expect(
      await googleObjectIds(after.credentials.issuerId, after.objectIdHmacKey, idScope),
    ).toEqual(originalIds);
    const callback = await readGoogleCallbackVerification(rolloverCtx, {
      ...scope,
      accountId: account.accountId,
      accountRevision: rotated.revision,
      credentialKeysetCommitment,
    });
    expect(callback?.objectIdHmacKey).toEqual(before.objectIdHmacKey);
  }, 30_000);

  it('fails closed if the current Google envelope references an unavailable KEK', async () => {
    const f = await googleFixture();
    const initialCtx = createServiceContext(
      { ...f.env, KEK_V1, KEK_V2: undefined, KEK_V3: undefined },
      { clock: f.clock },
    );
    const scope = { orgId: f.orgId, mode: 'live' as const, provider: 'google' as const };
    const credentialKeysetCommitment = await ensureCredentialRefKeyset(
      initialCtx.env.DB,
      initialCtx.env,
    );
    const account = await configureWalletProviderAccount(initialCtx, f.auth, {
      ...scope,
      expectedRevision: 0,
      credentials: f.google,
    });
    if (!account.accountId) throw new Error('Missing Google account');
    const expected = {
      accountId: account.accountId,
      accountRevision: account.revision,
      credentialKeysetCommitment,
    };
    const before = await googleSnapshot(
      initialCtx,
      f.orgId,
      account.accountId,
      account.revision,
      credentialKeysetCommitment,
    );
    const beforeRow = await findAccount(f.env.DB, scope);
    if (!beforeRow?.credential_id) throw new Error('Missing Google envelope');
    expect(beforeRow.kek_version).toBe(1);
    const beforeCredentials = await all(
      f.env.DB,
      'SELECT id, kek_version FROM wallet_provider_credentials WHERE account_id = ? ORDER BY id',
      [account.accountId],
    );
    const beforeEvents = await all(
      f.env.DB,
      'SELECT id, revision, credential_id FROM wallet_provider_account_events WHERE account_id = ? ORDER BY revision',
      [account.accountId],
    );

    // Keep the derived HMAC key stable while omitting the envelope's recorded KEK version.
    const missingCtx = createServiceContext(
      { ...f.env, KEK_V1: '', KEK_V2: KEK_V1, KEK_V3: undefined },
      { clock: f.clock },
    );
    await expect(
      readConfiguredWalletProviderCredentials(missingCtx, scope, expected),
    ).rejects.toMatchObject({ code: 'WALLET_CREDENTIALS_UNAVAILABLE' });
    await expect(
      readGoogleCallbackVerification(missingCtx, { ...scope, ...expected }),
    ).rejects.toMatchObject({ code: 'WALLET_CREDENTIALS_UNAVAILABLE' });
    await expect(
      configureWalletProviderAccount(missingCtx, f.auth, {
        ...scope,
        expectedRevision: account.revision,
        credentials: f.rotatedGoogle,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_CREDENTIALS_UNAVAILABLE' });
    expect(await findAccount(f.env.DB, scope)).toEqual(beforeRow);
    expect(
      await all(
        f.env.DB,
        'SELECT id, kek_version FROM wallet_provider_credentials WHERE account_id = ? ORDER BY id',
        [account.accountId],
      ),
    ).toEqual(beforeCredentials);
    expect(
      await all(
        f.env.DB,
        'SELECT id, revision, credential_id FROM wallet_provider_account_events WHERE account_id = ? ORDER BY revision',
        [account.accountId],
      ),
    ).toEqual(beforeEvents);
    expect(
      (
        await googleSnapshot(
          initialCtx,
          f.orgId,
          account.accountId,
          account.revision,
          credentialKeysetCommitment,
        )
      ).objectIdHmacKey,
    ).toEqual(before.objectIdHmacKey);
  }, 30_000);

  it('recovers a promoted historical Samsung ref only with its original envelope key', async () => {
    const f = await historicalSamsung();
    const initial = await all(
      f.db,
      `SELECT id, ref_hash, instance_id, kek_version, iv, wrapped_dek, ciphertext,
      promoted_at, retired_at, credential_keyset_commitment FROM wallet_samsung_fetch_refs WHERE instance_id = ?`,
      [f.instanceId],
    );
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({
      id: f.refRowId,
      ref_hash: f.refHash,
      instance_id: f.instanceId,
      kek_version: 1,
      retired_at: null,
      credential_keyset_commitment: f.credentialKeysetCommitment,
    });
    expect(JSON.stringify(initial)).not.toContain(f.refId);
    expect(await getSamsungRefreshTarget(f.kit.ctx, f.refScope)).toEqual({
      refId: f.refId,
      countryCodes: [],
    });

    // The call must use one entry-time keyring even if the live bindings change while
    // the commitment check is suspended and before the stored ref is decrypted.
    const liveEnv = { ...f.kit.env, KEK_V2: undefined as string | undefined };
    const liveCtx = { ...f.kit.ctx, env: liveEnv };
    const pending = getSamsungRefreshTarget(liveCtx, f.refScope);
    liveEnv.KEK_V1 = '';
    liveEnv.KEK_V2 = KEK_V2;
    expect(await pending).toEqual({ refId: f.refId, countryCodes: [] });
    const startedWithWrongKey = getSamsungRefreshTarget(liveCtx, f.refScope);
    liveEnv.KEK_V1 = KEK_V1;
    liveEnv.KEK_V2 = undefined;
    await expect(startedWithWrongKey).rejects.toMatchObject({
      code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    });

    const rolloverCtx = createServiceContext(
      { ...f.kit.env, KEK_V2, KEK_V3: undefined },
      { clock: f.kit.clock },
    );
    expect(await getSamsungRefreshTarget(rolloverCtx, f.refScope)).toEqual({
      refId: f.refId,
      countryCodes: [],
    });
    // Preserve the sentinel's HMAC key while removing version 1: the envelope must still
    // require its recorded version, even when version 2 contains the same key material.
    const missingCtx = createServiceContext(
      { ...f.kit.env, KEK_V1: '', KEK_V2: f.kit.env.KEK_V1, KEK_V3: undefined },
      { clock: f.kit.clock },
    );
    await expect(getSamsungRefreshTarget(missingCtx, f.refScope)).rejects.toThrow(
      'Samsung reference is unavailable.',
    );
    // New references are not authorized merely because the old encrypted ref cannot be opened.
    expect(
      await ensureSamsungFetchRef(missingCtx, {
        ...f.refScope,
        expiresAt: f.kit.clock.now() + 60_000,
      }),
    ).toBeNull();
    expect(
      await all(
        f.db,
        `SELECT id, ref_hash, instance_id, kek_version, iv, wrapped_dek, ciphertext,
      promoted_at, retired_at, credential_keyset_commitment FROM wallet_samsung_fetch_refs WHERE instance_id = ?`,
        [f.instanceId],
      ),
    ).toEqual(initial);
    expect(await getSamsungRefreshTarget(rolloverCtx, f.refScope)).toEqual({
      refId: f.refId,
      countryCodes: [],
    });
  }, 120_000);

  it('pins retirement keys before awaiting and never retires under a mismatched entry keyset', async () => {
    const f = await historicalSamsung(false);
    f.kit.clock.advance(1_001);
    const scope = { ...f.refScope, claimHandle: f.claimHandle };
    const before = await all(
      f.db,
      `SELECT id, ref_hash, kek_version, retired_at, credential_keyset_commitment
      FROM wallet_samsung_fetch_refs WHERE instance_id = ?`,
      [f.instanceId],
    );
    expect(before).toEqual([
      {
        id: f.refRowId,
        ref_hash: f.refHash,
        kek_version: 1,
        retired_at: null,
        credential_keyset_commitment: f.credentialKeysetCommitment,
      },
    ]);
    const beforeClaim = await first(
      f.db,
      `SELECT state, claim_hash, claim_expires_at FROM wallet_provider_instance_operations
      WHERE instance_id = ? AND version = 2`,
      [f.instanceId],
    );
    expect(beforeClaim).toMatchObject({ state: 'claimed' });
    const liveEnv = { ...f.kit.env, KEK_V1: '', KEK_V2: KEK_V2 as string | undefined };
    const liveCtx = { ...f.kit.ctx, env: liveEnv };
    const pending = retireExpiredUnpromotedRef(liveCtx, scope);
    // Restoring the key after entry must not launder the already-captured bad keyset.
    liveEnv.KEK_V1 = KEK_V1;
    liveEnv.KEK_V2 = undefined;
    await expect(pending).rejects.toMatchObject({ code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE' });
    expect(
      await all(
        f.db,
        `SELECT id, ref_hash, kek_version, retired_at, credential_keyset_commitment
      FROM wallet_samsung_fetch_refs WHERE instance_id = ?`,
        [f.instanceId],
      ),
    ).toEqual(before);
    expect(
      await first(
        f.db,
        `SELECT state, claim_hash, claim_expires_at FROM wallet_provider_instance_operations
      WHERE instance_id = ? AND version = 2`,
        [f.instanceId],
      ),
    ).toEqual(beforeClaim);
    // The same expired ref and claim are genuinely eligible when started with the right keys.
    expect(await retireExpiredUnpromotedRef(liveCtx, scope)).toBe('no_external_card');
    expect(
      await all(
        f.db,
        `SELECT id, ref_hash, retired_at FROM wallet_samsung_fetch_refs WHERE instance_id = ?`,
        [f.instanceId],
      ),
    ).toEqual([{ id: f.refRowId, ref_hash: f.refHash, retired_at: f.kit.clock.now() }]);
  }, 120_000);

  it('does not stage a provider generation or retirement when the credential keyset changes', async () => {
    const f = await historicalSamsung();
    const { db, kit, pass, instanceId } = f;
    const expected = await getHolderPass(db, pass.id, null);
    if (!expected) throw new Error('Missing original holder');
    const commitment = await ensureCredentialRefKeyset(db, kit.env);
    expect(await first(db, 'SELECT commitment FROM credential_ref_keyset WHERE id = 1')).toEqual({
      commitment,
    });
    const snapshot = async () => ({
      pass: await first(
        db,
        `SELECT holder_email, owner_user_id, credential_generation, link_generation,
        download_token, serial, auth_token, scan_code, object_key, version, revision FROM passes WHERE id = ?`,
        [pass.id],
      ),
      instances: await all(
        db,
        `SELECT id, provider, credential_generation, lifecycle, desired_version,
        desired_operation_id, retirement_requested_at, retired_at, credential_keyset_commitment FROM wallet_provider_instances
        WHERE pass_id = ? ORDER BY credential_generation, provider`,
        [pass.id],
      ),
      operations: await all(
        db,
        `SELECT op.id, op.version, op.kind, op.state, op.credential_keyset_commitment FROM wallet_provider_instance_operations op
        JOIN wallet_provider_instances i ON i.id = op.instance_id WHERE i.pass_id = ? ORDER BY op.version`,
        [pass.id],
      ),
      dirty: await all(
        db,
        `SELECT d.instance_id, d.generation, d.next_attempt_at FROM wallet_provider_instance_dirty d
        JOIN wallet_provider_instances i ON i.id = d.instance_id WHERE i.pass_id = ?`,
        [pass.id],
      ),
      transfers: await all(db, 'SELECT * FROM pass_credential_transfers WHERE pass_id = ?', [
        pass.id,
      ]),
      tombstones: await all(db, 'SELECT * FROM pass_credential_tombstones WHERE pass_id = ?', [
        pass.id,
      ]),
      refs: await all(
        db,
        `SELECT id, ref_hash, kek_version, retired_at, credential_keyset_commitment FROM wallet_samsung_fetch_refs
        WHERE instance_id = ?`,
        [instanceId],
      ),
    });
    const before = await snapshot();
    expect(before.instances).toHaveLength(1);
    expect(before.instances[0]).toMatchObject({
      id: instanceId,
      retirement_requested_at: null,
      credential_keyset_commitment: commitment,
    });
    expect(before.transfers).toEqual([]);
    expect(before.tombstones).toEqual([]);
    expect(before.refs).toEqual([
      {
        id: f.refRowId,
        ref_hash: f.refHash,
        kek_version: 1,
        retired_at: null,
        credential_keyset_commitment: commitment,
      },
    ]);
    expect(before.operations).toContainEqual(
      expect.objectContaining({
        version: 2,
        kind: 'revoke',
        state: 'claimed',
        credential_keyset_commitment: commitment,
      }),
    );
    expect(await getSamsungRefreshTarget(kit.ctx, f.refScope)).toEqual({
      refId: f.refId,
      countryCodes: [],
    });

    // Change only the oldest derived-key source. The original envelope is still decryptable,
    // so denial cannot be explained by a missing or invalid encryption key.
    const wrongOldestEnv = { ...kit.env, KEK_V0: KEK_V2 };
    const wrongOldestCtx = createServiceContext(wrongOldestEnv, { clock: kit.clock });
    const refRow = await first<{
      kek_version: number;
      iv: number[];
      wrapped_dek: number[];
      ciphertext: number[];
    }>(
      db,
      'SELECT kek_version, iv, wrapped_dek, ciphertext FROM wallet_samsung_fetch_refs WHERE id = ?',
      [f.refRowId],
    );
    if (!refRow) throw new Error('Missing Samsung envelope');
    const envelope = {
      kekVersion: refRow.kek_version,
      iv: new Uint8Array(refRow.iv),
      wrappedDek: new Uint8Array(refRow.wrapped_dek),
      ciphertext: new Uint8Array(refRow.ciphertext),
    };
    expect(
      await decryptSecretText(
        await loadKekRing(wrongOldestCtx.env),
        envelope,
        credentialAad(f.refRowId, pass.orgId, `samsung-ref|${pass.mode}|${instanceId}`),
      ),
    ).toBe(f.refId);
    await expect(getSamsungRefreshTarget(wrongOldestCtx, f.refScope)).rejects.toMatchObject({
      code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    });
    // New issuance remains disabled independently of the keyset failure.
    expect(
      await ensureSamsungFetchRef(wrongOldestCtx, {
        ...f.refScope,
        expiresAt: kit.clock.now() + 60_000,
      }),
    ).toBeNull();
    await expect(
      retireExpiredUnpromotedRef(wrongOldestCtx, { ...f.refScope, claimHandle: f.claimHandle }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE' });
    await expect(
      completeWalletOperation(wrongOldestCtx, {
        orgId: pass.orgId,
        mode: pass.mode,
        provider: 'samsung',
        instanceId,
        version: 2,
        credentialKeysetCommitment: commitment,
        claimHandle: f.claimHandle,
        now: kit.clock.now(),
        result: { kind: 'success', httpStatus: 200 },
      }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE' });
    expect(await snapshot()).toEqual(before);

    const originalV1 = kit.env.KEK_V1;
    const originalV2 = kit.env.KEK_V2;
    try {
      kit.env.KEK_V2 = KEK_V2;
      expect(await ensureCredentialRefKeyset(db, kit.env)).toBe(commitment);
      kit.env.KEK_V1 = '';
      await expect(ensureCredentialRefKeyset(db, kit.env)).rejects.toMatchObject({
        code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
      });
      await expect(
        startCredentialTransfer(
          jobCtxOf(kit),
          { type: 'system', id: null },
          pass.id,
          { holderEmail: 'next-holder@example.test', ownerUserId: null },
          null,
          { kind: 'tenant-holder', expected },
        ),
      ).rejects.toMatchObject({ code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE' });
      expect(await snapshot()).toEqual(before);
      expect(await first(db, 'SELECT commitment FROM credential_ref_keyset WHERE id = 1')).toEqual({
        commitment,
      });
    } finally {
      kit.env.KEK_V1 = originalV1;
      kit.env.KEK_V2 = originalV2;
    }
    expect(await ensureCredentialRefKeyset(db, kit.env)).toBe(commitment);
  }, 120_000);
});
