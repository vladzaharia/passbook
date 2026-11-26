import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { type AppBindings, requestContext } from '../../platform/context.ts';
import { all, batch, first, run, stmt } from '../../platform/db.ts';
import { handleError } from '../../platform/error-handler.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { readGoogleCallbackVerification } from './account-service.ts';
import { clearGoogleCallbackKeyCache } from './google-callback-crypto.ts';
import {
  type CallbackSigningKeys,
  callbackKeyset,
  makeCallbackSigningKeys,
  signedGoogleEvent,
} from './google-callback-test-kit.ts';
import { googleObjectIds } from './google-ids.ts';
import {
  claimWalletOperation,
  completeWalletOperation,
  getWalletInstanceById,
  newWalletClaimHandle,
  readWalletPassSnapshot,
} from './instance.ts';
import { reconcileWalletInstance } from './lifecycle.ts';
import { setupWalletOfferKit } from './offers-test-fixtures.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { releaseRows } from './release-test-fixtures.ts';
import { findGoogleCallbackBinding } from './repo-google-callback.ts';
import { googleCallbackRoutes } from './routes-google-callbacks.ts';
import { seedHistoricalProviderInstance } from './runtime-historical-fixtures.ts';
import { historicalGoogleRelease } from './runtime-integration-fixtures.ts';
import { walletJobCtx } from './wallet-job-ctx-test-fixtures.ts';

// Historical Google instances exist only while a provider is enabled.
beforeAll(() => {
  setWalletProvidersEnabledForTest(true);
});
let keys: CallbackSigningKeys;
const testEnv = installKeysetTestEnv();
beforeAll(async () => {
  vi.setConfig({ testTimeout: 60_000 });
  keys = await makeCallbackSigningKeys();
});
beforeEach(() => clearGoogleCallbackKeyCache());
afterEach(() => vi.unstubAllGlobals());

async function setup() {
  const f = await setupWalletOfferKit({
    google: 'configured',
    samsung: 'absent',
    db: (await testEnv()).DB,
  });
  const db = f.kit.env.DB;
  const credentialKeysetCommitment = await requireCredentialRefKeyset(db, f.kit.env);
  // Successors (channel_epoch > 1) need the provider released in the database too (0226).
  await releaseRows(db);
  const account = await first<{ id: string; revision: number }>(
    db,
    "SELECT id, revision FROM wallet_provider_accounts WHERE org_id = ? AND mode = 'live' AND provider = 'google'",
    [f.pass.orgId],
  );
  if (!account) throw new Error('Missing Google fixture account.');
  const scope = {
    orgId: f.pass.orgId,
    mode: 'live' as const,
    accountId: account.id,
    accountRevision: account.revision,
    credentialKeysetCommitment,
  };
  const verification = await readGoogleCallbackVerification(f.kit.ctx, scope);
  if (!verification) throw new Error('Missing Google fixture verification identity.');
  const releaseId = await historicalGoogleRelease(f);
  const snapshot = await readWalletPassSnapshot(db, {
    ...scope,
    passId: f.pass.id,
  });
  if (!snapshot) throw new Error('Missing pass snapshot.');
  const ids = (channelEpoch: number) =>
    googleObjectIds(verification.issuerId, verification.objectIdHmacKey, {
      tenantId: f.pass.orgId,
      mode: 'live',
      releaseId,
      passId: f.pass.id,
      credentialGeneration: snapshot.credentialGeneration,
      channelEpoch,
    });
  const bind = async (instanceId: string, channelEpoch: number) => {
    const { classId, objectId } = await ids(channelEpoch);
    await run(
      db,
      `INSERT INTO wallet_google_callback_bindings
        (instance_id, account_id, class_id_hash, object_id_hash, created_at, credential_keyset_commitment)
      VALUES (?, ?, ?, ?, ?, ?)`,
      [
        instanceId,
        account.id,
        await sha256Hex(classId),
        await sha256Hex(objectId),
        f.kit.clock.now(),
        credentialKeysetCommitment,
      ],
    );
  };
  const first1 = await seedHistoricalProviderInstance(db, {
    id: f.kit.ctx.ids.id(),
    passId: f.pass.id,
    orgId: f.pass.orgId,
    mode: 'live',
    provider: 'google',
    credentialGeneration: snapshot.credentialGeneration,
    credentialKeysetCommitment,
    accountId: account.id,
    releaseId,
    operationId: f.kit.ctx.ids.id(),
    now: f.kit.clock.now(),
    upsert: { requestHash: await sha256Hex(f.kit.ctx.ids.token(32)), state: 'succeeded' },
  });
  if (!first1) throw new Error('Missing Google epoch 1 instance.');
  await bind(first1.instanceId, 1);
  const marker = (retiredAt: number | null) =>
    run(
      db,
      `INSERT INTO pass_channels (pass_id, org_id, mode, template_id, channel, retired_at, retired_cause,
        set_by, set_at) VALUES (?, ?, ?, ?, 'google', ?, ?, 'test', ?)
      ON CONFLICT (pass_id, channel) DO UPDATE SET retired_at = excluded.retired_at,
        retired_cause = excluded.retired_cause`,
      [
        f.pass.id,
        f.pass.orgId,
        f.pass.mode,
        f.pass.templateId,
        retiredAt,
        retiredAt === null ? null : 'pass',
        f.kit.clock.now(),
      ],
    );
  const instance = async (id: string) => {
    const row = await getWalletInstanceById(db, {
      orgId: scope.orgId,
      mode: scope.mode,
      provider: 'google',
      instanceId: id,
    });
    if (!row) throw new Error('Missing instance.');
    return row;
  };
  const proof = {
    orgId: scope.orgId,
    mode: scope.mode,
    provider: 'google' as const,
    credentialKeysetCommitment,
    passId: f.pass.id,
    passVersion: snapshot.passVersion,
    passRevision: snapshot.passRevision,
    lifecycleGeneration: snapshot.lifecycleGeneration,
    passCredentialGeneration: snapshot.credentialGeneration,
    issuingReleaseId: snapshot.issuingReleaseId,
    projectionReleaseId: releaseId,
    accountId: account.id,
    accountRevision: account.revision,
    adapterRevision: first1.adapterRevision,
    policyRevision: first1.policyRevision,
  };
  return { ...f, db, scope, account, first1, ids, bind, marker, instance, proof, releaseId };
}

/** Off, settle the revoke, then re-enable and insert the epoch 2 successor. */
async function retireAndSucceed(t: Awaited<ReturnType<typeof setup>>) {
  await t.marker(t.kit.clock.now());
  expect(
    await reconcileWalletInstance(jobCtxOf(t.kit), await t.instance(t.first1.instanceId)),
  ).toBe('scheduled');
  const staged = await t.instance(t.first1.instanceId);
  const claim = {
    orgId: t.scope.orgId,
    mode: t.scope.mode,
    provider: 'google' as const,
    credentialKeysetCommitment: t.scope.credentialKeysetCommitment,
    instanceId: staged.id,
    version: staged.desiredVersion,
    claimHandle: newWalletClaimHandle(),
    now: t.kit.clock.now(),
  };
  expect(await claimWalletOperation(walletJobCtx(t.db), claim)).toBe('claimed');
  await completeWalletOperation(jobCtxOf(t.kit), { ...claim, result: { kind: 'success' } });
  await t.marker(null);
  const successor = {
    ...t.proof,
    instanceId: t.kit.ctx.ids.id(),
    operationId: t.kit.ctx.ids.id(),
    requestHash: await sha256Hex(t.kit.ctx.ids.token(32)),
    now: t.kit.clock.now(),
    channelEpoch: 2,
  };
  // The historical release carries no current publisher proof, so insertInstance's operation proof
  // would refuse it; insert the rows directly and let the 0114 successor trigger decide.
  await batch(t.db, [
    stmt(
      t.db,
      `INSERT INTO wallet_provider_instances
        (id, pass_id, org_id, mode, provider, account_id, identity_projection_release_id,
         credential_generation, channel_epoch, credential_keyset_commitment, desired_version,
         desired_operation_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'google', ?, ?, ?, 2, ?, 1, ?, ?, ?)`,
      [
        successor.instanceId,
        t.pass.id,
        t.scope.orgId,
        t.scope.mode,
        t.account.id,
        t.releaseId,
        t.proof.passCredentialGeneration,
        t.scope.credentialKeysetCommitment,
        successor.operationId,
        successor.now,
        successor.now,
      ],
    ),
    stmt(
      t.db,
      `INSERT INTO wallet_provider_instance_operations
        (id, instance_id, version, kind, request_hash, pass_version, pass_revision, lifecycle_generation,
         pass_credential_generation, issuing_release_id, projection_release_id, account_revision,
         adapter_revision, policy_revision, credential_keyset_commitment, created_at, pass_row_version, account_epoch)
      VALUES (?, ?, 1, 'upsert', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        (SELECT row_version FROM passes WHERE id = ?),
        (SELECT authority_epoch FROM wallet_provider_accounts WHERE id = ?))`,
      [
        successor.operationId,
        successor.instanceId,
        successor.requestHash,
        t.proof.passVersion,
        t.proof.passRevision,
        t.proof.lifecycleGeneration,
        t.proof.passCredentialGeneration,
        t.proof.issuingReleaseId,
        t.releaseId,
        t.account.revision,
        t.proof.adapterRevision,
        t.proof.policyRevision,
        t.scope.credentialKeysetCommitment,
        successor.now,
        t.proof.passId,
        t.proof.accountId,
      ],
    ),
  ]);
  return successor;
}

function callbackApp(t: Awaited<ReturnType<typeof setup>>) {
  const app = new Hono<AppBindings>();
  app.use('*', requestContext({ stores: denyAllStores, clock: t.kit.clock }));
  app.onError(handleError);
  app.route('/wallet/v1/google', googleCallbackRoutes);
  return app;
}

describe('Google channel_off retirement and successor', () => {
  it('derives epoch 1 ids as before and gives each epoch its own object', async () => {
    const t = await setup();
    const [one, again, two, three] = await Promise.all([t.ids(1), t.ids(1), t.ids(2), t.ids(3)]);
    expect(again).toEqual(one);
    expect(new Set([one.objectId, two.objectId, three.objectId]).size).toBe(3);
    // The class is shared by the release, never by the epoch.
    expect(two.classId).toBe(one.classId);
  });

  it('frees the slot at revoked, keeps the predecessor, and reads the successor as the slot', async () => {
    const t = await setup();
    const successor = await retireAndSucceed(t);
    expect(await t.instance(t.first1.instanceId)).toMatchObject({
      lifecycle: 'revoked',
      retirementCause: 'channel_off',
      channelEpoch: 1,
    });
    expect(await t.instance(successor.instanceId)).toMatchObject({
      lifecycle: 'active',
      channelEpoch: 2,
      retirementCause: null,
    });
    const rows = await all(
      t.db,
      'SELECT id FROM wallet_provider_instances WHERE pass_id = ? AND provider = ?',
      [t.pass.id, 'google'],
    );
    expect(rows).toHaveLength(2);
  });

  it('routes a callback on the epoch 1 object to the predecessor and epoch 2 to the successor', async () => {
    const t = await setup();
    const successor = await retireAndSucceed(t);
    await t.bind(successor.instanceId, 2);
    const hashes = async (epoch: number) => {
      const { classId, objectId } = await t.ids(epoch);
      return [await sha256Hex(classId), await sha256Hex(objectId)] as const;
    };
    const scope = { ...t.scope };
    const [c1, o1] = await hashes(1);
    const [c2, o2] = await hashes(2);
    expect(await findGoogleCallbackBinding(t.db, scope, c1, o1)).toMatchObject({
      instanceId: t.first1.instanceId,
      channelEpoch: 1,
    });
    expect(await findGoogleCallbackBinding(t.db, scope, c2, o2)).toMatchObject({
      instanceId: successor.instanceId,
      channelEpoch: 2,
    });
    // The class is shared by the release, so the object hash is what selects the instance.
    expect(c1).toBe(c2);
    expect(await findGoogleCallbackBinding(t.db, scope, c1, 'f'.repeat(64))).toBeNull();

    vi.stubGlobal('fetch', async () =>
      Response.json(await callbackKeyset(keys.root, t.kit.clock.now() + 60_000)),
    );
    const verification = await readGoogleCallbackVerification(t.kit.ctx, scope);
    if (!verification) throw new Error('Missing verification identity.');
    const post = async (epoch: number, nonce: string) => {
      const ids = await t.ids(epoch);
      const body = await signedGoogleEvent(
        keys,
        verification.issuerId,
        {
          classId: ids.classId,
          objectId: ids.objectId,
          nonce,
          eventType: 'save',
          expTimeMillis: String(t.kit.clock.now() + 60_000),
        },
        { keyExpiration: t.kit.clock.now() + 60_000 },
      );
      return callbackApp(t).request(
        `https://passbook.mobile/wallet/v1/google/${t.account.id}`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body },
        t.kit.env,
      );
    };
    expect((await post(2, 'nonce-epoch-2')).status).toBe(204);
    expect((await post(1, 'nonce-epoch-1')).status).toBe(204);
    const receipts = await all<{ instance_id: string }>(
      t.db,
      'SELECT instance_id FROM wallet_google_callback_receipts ORDER BY instance_id',
    );
    expect(receipts.map((r) => r.instance_id).sort()).toEqual(
      [t.first1.instanceId, successor.instanceId].sort(),
    );
  });

  it('re-derives with the bound instance epoch, so a lookup row on the wrong instance is refused', async () => {
    const t = await setup();
    await retireAndSucceed(t);
    // The predecessor's lookup row is corrupted to the epoch 2 object: re-deriving with epoch 1 disagrees.
    const two = await t.ids(2);
    await run(
      t.db,
      'UPDATE wallet_google_callback_bindings SET object_id_hash = ? WHERE instance_id = ?',
      [await sha256Hex(two.objectId), t.first1.instanceId],
    );
    vi.stubGlobal('fetch', async () =>
      Response.json(await callbackKeyset(keys.root, t.kit.clock.now() + 60_000)),
    );
    const verification = await readGoogleCallbackVerification(t.kit.ctx, t.scope);
    if (!verification) throw new Error('Missing verification identity.');
    const body = await signedGoogleEvent(
      keys,
      verification.issuerId,
      {
        classId: two.classId,
        objectId: two.objectId,
        nonce: 'nonce-wrong-epoch',
        eventType: 'save',
        expTimeMillis: String(t.kit.clock.now() + 60_000),
      },
      { keyExpiration: t.kit.clock.now() + 60_000 },
    );
    const response = await callbackApp(t).request(
      `https://passbook.mobile/wallet/v1/google/${t.account.id}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body },
      t.kit.env,
    );
    expect(response.status).toBe(401);
    expect(await all(t.db, 'SELECT id FROM wallet_google_callback_receipts')).toEqual([]);
  });
});
