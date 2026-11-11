import { describe, expect, it } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { all, first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import {
  finishCredentialTransfer,
  startCredentialTransfer,
} from '../passes/credential-transfer.ts';
import { setupKit } from '../passes/pass-test-fixtures.ts';
import { setDownloadToken } from '../passes/repo.ts';
import { getPass, getPassByDownloadToken } from '../passes/repo-read-pass.ts';
import { setupSamsungCallbacks } from '../wallet-providers/callbacks-test-fixtures.ts';
import {
  claimWalletOperation,
  completeWalletOperation,
  consumeWalletOfferRef,
  createWalletOfferRef,
  getWalletInstanceById,
  getWalletOperation,
  newWalletClaimHandle,
  walletOfferFresh,
} from '../wallet-providers/instance.ts';
import { reconcileWalletInstance } from '../wallet-providers/lifecycle.ts';
import { listWalletOffers } from '../wallet-providers/offers.ts';
import { makeProviderTestTemplate } from '../wallet-providers/offers-test-fixtures.ts';
import { whileDisabledForTest } from '../wallet-providers/provider-policy.ts';
import { readOffer } from '../wallet-providers/repo-instance-offers.ts';
import { seedHistoricalOfferRef } from '../wallet-providers/runtime-historical-fixtures.ts';
import { finishWalletProviderRetirement } from '../wallet-providers/sync-operation-retirement.ts';
import { getHolderPass } from './repo.ts';
import {
  assignHolder,
  attachWaitingPassesForEmail,
  clearBlock,
  getHolder,
  listHolders,
  reassignHolder,
  runAttachHookA,
  unassignHolder,
} from './service.ts';
import { removePassFromUser } from './service-remove.ts';
import { ownerSessionId } from './test-auth-fixtures.ts';

const actor = { type: 'system', id: null } as const;
// Storage lasts for the whole file; the credential keyset is immutable, so each case gets its own D1.
const makeEnv = installKeysetTestEnv();
const testDatabase = async () => (await makeEnv()).DB;

describe('holder changes and native wallet retirement', () => {
  it('retires a historical promoted credential and its old bearer before a transfer can expose it', async () => {
    const t = await setupSamsungCallbacks({ db: await testDatabase() });
    const db = t.kit.env.DB;
    const { credentialKeysetCommitment } = t;
    const scope = {
      orgId: t.pass.orgId,
      mode: t.pass.mode,
      provider: 'samsung' as const,
      instanceId: t.operation.instanceId,
      credentialKeysetCommitment,
    };
    expect(
      await whileDisabledForTest(createWalletOfferRef, db, {
        ...scope,
        version: t.operation.version,
        authority: { kind: 'download', token: t.pass.downloadToken },
        now: t.kit.clock.now(),
      }),
    ).toBeNull();
    const wrapper = t.kit.ctx.ids.token(32);
    const wrapperHash = await sha256Hex(wrapper);
    await seedHistoricalOfferRef(db, {
      refHash: wrapperHash,
      instanceId: scope.instanceId,
      operationVersion: t.operation.version,
      createdAt: t.kit.clock.now(),
      expiresAt: t.kit.clock.now() + 300_000,
      consumedAt: null,
      deliveredAt: null,
    });
    expect(
      await readOffer(db, wrapperHash, t.kit.clock.now(), credentialKeysetCommitment),
    ).not.toBeNull();
    expect((await t.call({ token: await t.token() })).status).toBe(200);

    const holder = await reassignHolder(
      jobCtxOf(t.kit),
      actor,
      { passId: t.pass.id, email: 'next@example.test' },
      null,
    );
    expect(holder.transfer).toMatchObject({ state: 'pending', transferId: expect.any(String) });
    expect(holder.email).toBe(t.pass.holderEmail);
    const pending = await getPass(db, t.pass.id);
    expect(pending).toMatchObject({
      credentialGeneration: t.pass.credentialGeneration + 1,
      holderEmail: t.pass.holderEmail,
      serial: t.pass.serial,
      authToken: t.pass.authToken,
      scanCode: t.pass.scanCode,
    });
    expect(pending?.downloadToken).not.toBe(t.pass.downloadToken);
    expect(await getPassByDownloadToken(db, t.pass.downloadToken)).toBeNull();
    await expect(
      reassignHolder(
        jobCtxOf(t.kit),
        actor,
        { passId: t.pass.id, email: 'other@example.test' },
        null,
      ),
    ).rejects.toMatchObject({ code: 'HOLDER_TRANSFER_PENDING' });
    expect(await listWalletOffers(jobCtxOf(t.kit), t.pass.id)).toEqual([]);
    const session = await makeSession(t.kit.fx, { userId: t.auth.userId, roles: ['user'] });
    const app = createApp({
      clock: t.kit.clock,
      stores: { ...denyAllStores, sessions: createSessionStore(t.kit.env, t.kit.clock) },
    });
    const response = await app.request(
      `https://wallet.test/api/v1/holders/${t.pass.id}`,
      { headers: session.headers },
      t.kit.env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      email: t.pass.holderEmail,
      transfer: holder.transfer,
    });
    expect(
      await finishCredentialTransfer(jobCtxOf(t.kit), holder.transfer!.transferId),
    ).toMatchObject({
      state: 'pending',
    });
    expect(
      await readOffer(db, wrapperHash, t.kit.clock.now(), credentialKeysetCommitment),
    ).toBeNull();
    expect(await walletOfferFresh(db, wrapper, t.kit.clock.now(), credentialKeysetCommitment)).toBe(
      false,
    );
    expect(
      await consumeWalletOfferRef(db, wrapper, t.kit.clock.now(), credentialKeysetCommitment),
    ).toBeNull();
    expect((await t.call({ token: await t.token() })).status).not.toBe(200);
    const old = await getWalletInstanceById(db, scope);
    expect(old).toMatchObject({
      retirementRequestedAt: expect.any(Number),
      installationState: 'unknown',
    });
    expect(
      await first(
        db,
        'SELECT instance_id FROM wallet_provider_instance_dirty WHERE instance_id = ?',
        [scope.instanceId],
      ),
    ).not.toBeNull();
    if (!old) throw new Error('Missing previous incarnation');
    expect(
      await all(
        db,
        `SELECT provider, lifecycle, account_id, desired_operation_id
      FROM wallet_provider_instances WHERE pass_id = ? AND credential_generation = ? ORDER BY provider`,
        [t.pass.id, t.pass.credentialGeneration + 1],
      ),
    ).toEqual([
      { provider: 'google', lifecycle: 'blocked', account_id: null, desired_operation_id: null },
      { provider: 'samsung', lifecycle: 'blocked', account_id: null, desired_operation_id: null },
    ]);

    expect(await reconcileWalletInstance(jobCtxOf(t.kit), old)).toBe('scheduled');
    const retiring = await getWalletInstanceById(db, scope);
    if (!retiring) throw new Error('Missing retiring incarnation');
    const operation = await getWalletOperation(db, { ...scope, version: retiring.desiredVersion });
    expect(operation).toMatchObject({ kind: 'revoke', state: 'pending' });
    const claim = {
      ...scope,
      version: retiring.desiredVersion,
      claimHandle: newWalletClaimHandle(),
      now: t.kit.clock.now(),
    };
    expect(await claimWalletOperation(db, claim)).toBe('claimed');
    // Model the authenticated provider acceptance, not installation on a holder device.
    expect(
      await completeWalletOperation(jobCtxOf(t.kit), {
        ...claim,
        result: { kind: 'success', httpStatus: 200 },
      }),
    ).toBe('succeeded');
    expect(await finishWalletProviderRetirement(jobCtxOf(t.kit), claim)).toBe(true);
    expect(await getWalletInstanceById(db, scope)).toMatchObject({
      lifecycle: 'retired',
      installationState: 'unknown',
    });
    const tombstone = await first<Record<string, unknown>>(
      db,
      'SELECT * FROM wallet_samsung_tombstones WHERE ref_hash = ?',
      [await sha256Hex(t.refId)],
    );
    expect(tombstone).not.toBeNull();
    expect(JSON.stringify(tombstone)).not.toContain(t.pass.id);
    expect(JSON.stringify(tombstone)).not.toContain('next@example.test');
    expect((await t.call({ token: await t.token() })).status).toBe(204);
    if (!holder.transfer) throw new Error('Missing transfer result');
    expect(
      await finishCredentialTransfer(jobCtxOf(t.kit), holder.transfer.transferId),
    ).toMatchObject({
      state: 'completed',
    });
    const fresh = await getPass(db, t.pass.id);
    expect(fresh).toMatchObject({
      holderEmail: 'next@example.test',
      credentialGeneration: t.pass.credentialGeneration + 1,
    });
    expect(fresh?.serial).not.toBe(t.pass.serial);
    expect(fresh?.authToken).not.toBe(t.pass.authToken);
    expect(fresh?.scanCode).not.toBe(t.pass.scanCode);
    expect(
      await all(
        db,
        `SELECT provider, lifecycle, account_id, desired_operation_id
      FROM wallet_provider_instances WHERE pass_id = ? AND credential_generation = ? ORDER BY provider`,
        [t.pass.id, t.pass.credentialGeneration + 1],
      ),
    ).toEqual([
      { provider: 'google', lifecycle: 'ready', account_id: null, desired_operation_id: null },
      { provider: 'samsung', lifecycle: 'ready', account_id: null, desired_operation_id: null },
    ]);
    expect(await listWalletOffers(jobCtxOf(t.kit), t.pass.id)).toEqual([]);
  }, 120_000);

  it.each([
    ['revision', 'UPDATE passes SET revision = revision + 1 WHERE id = ?'],
    ['lifecycle', 'UPDATE passes SET lifecycle_generation = lifecycle_generation + 1 WHERE id = ?'],
    ['link', 'UPDATE passes SET link_generation = link_generation + 1 WHERE id = ?'],
    ['credential', null],
  ])(
    'does not retire a credential when a stale holder CAS loses on %s',
    async (_dimension, mutation) => {
      const t = await setupSamsungCallbacks({ db: await testDatabase() });
      const db = t.kit.env.DB;
      const captured = await getHolderPass(db, t.pass.id, null);
      if (!captured) throw new Error('Missing holder snapshot');
      if (mutation) await run(db, mutation, [t.pass.id]);
      else {
        const winner = await reassignHolder(
          jobCtxOf(t.kit),
          actor,
          { passId: t.pass.id, email: 'winner@example.test' },
          null,
        );
        expect(winner.transfer?.state).toBe('pending');
        expect((await getPass(db, t.pass.id))?.credentialGeneration).toBe(
          captured.credentialGeneration + 1,
        );
      }
      const dirty = await first(
        db,
        'SELECT generation, next_attempt_at FROM wallet_provider_instance_dirty WHERE instance_id = ?',
        [t.operation.instanceId],
      );
      const retained = await first(
        db,
        'SELECT retirement_requested_at FROM wallet_provider_instances WHERE id = ?',
        [t.operation.instanceId],
      );
      await expect(
        startCredentialTransfer(
          jobCtxOf(t.kit),
          actor,
          captured.id,
          { holderEmail: 'wrong@example.test', ownerUserId: null },
          null,
          { kind: 'tenant-holder', expected: captured },
        ),
      ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
      expect(
        await first(
          db,
          'SELECT retirement_requested_at FROM wallet_provider_instances WHERE id = ?',
          [t.operation.instanceId],
        ),
      ).toEqual(retained);
      expect(
        await first(
          db,
          'SELECT generation, next_attempt_at FROM wallet_provider_instance_dirty WHERE instance_id = ?',
          [t.operation.instanceId],
        ),
      ).toEqual(dirty);
      expect((await getPass(db, t.pass.id))?.holderEmail).toBe(captured.holderEmail);
    },
    120_000,
  );

  it('retires the old credential when its owner removes the pass', async () => {
    const kit = await setupKit({ db: await testDatabase(), template: makeProviderTestTemplate });
    const user = await makeUser(kit.fx);
    const apple = await approveAppleRelease(kit);
    const pass = await kit.pass({ holderEmail: user.primaryEmail });
    expect(pass.ownerUserId).toBe(user.id);
    const t = await setupSamsungCallbacks({ source: { kit, apple, pass, barcode: 'none' } });
    const bundleId = t.kit.fx.ids.id();
    await run(
      t.kit.env.DB,
      "INSERT INTO bundles (id, org_id, name, token, created_at) VALUES (?, ?, 'B', ?, 1)",
      [bundleId, t.pass.orgId, t.kit.fx.ids.token()],
    );
    await run(
      t.kit.env.DB,
      'INSERT INTO bundle_passes (bundle_id, pass_id, position) VALUES (?, ?, 0)',
      [bundleId, t.pass.id],
    );
    const transfer = await removePassFromUser(
      jobCtxOf(t.kit),
      t.pass.id,
      user.id,
      await ownerSessionId(t.kit, user.id),
    );
    expect(transfer).toMatchObject({ state: 'pending' });
    expect((await getPass(t.kit.env.DB, t.pass.id))?.ownerUserId).toBe(user.id);
    expect(
      await first(
        t.kit.env.DB,
        'SELECT target_owner_user_id, state FROM pass_credential_transfers WHERE id = ?',
        [transfer.transferId],
      ),
    ).toEqual({ target_owner_user_id: null, state: 'pending' });
    expect((await getPass(t.kit.env.DB, t.pass.id))?.downloadToken).not.toBe(t.pass.downloadToken);
    expect(await getPassByDownloadToken(t.kit.env.DB, t.pass.downloadToken)).toBeNull();
    expect(
      await first(t.kit.env.DB, 'SELECT 1 FROM bundle_passes WHERE bundle_id = ? AND pass_id = ?', [
        bundleId,
        t.pass.id,
      ]),
    ).toBeNull();
    expect(
      await first(
        t.kit.env.DB,
        'SELECT retirement_requested_at FROM wallet_provider_instances WHERE id = ?',
        [t.operation.instanceId],
      ),
    ).toEqual({ retirement_requested_at: t.kit.clock.now() });
    expect(
      await first(
        t.kit.env.DB,
        'SELECT 1 FROM pass_attach_blocks WHERE pass_id = ? AND user_id = ?',
        [t.pass.id, user.id],
      ),
    ).not.toBeNull();
  }, 120_000);

  it.each(['assign', 'unassign'] as const)(
    'exposes %s as pending without changing the current holder or creating offers',
    async (operation) => {
      const t = await setupSamsungCallbacks({
        ...(operation === 'unassign' ? { holderEmail: 'before@example.test' } : {}),
        db: await testDatabase(),
      });
      const user = await makeUser(t.kit.fx);
      const holder =
        operation === 'assign'
          ? await assignHolder(
              jobCtxOf(t.kit),
              actor,
              { passId: t.pass.id, email: user.primaryEmail },
              null,
            )
          : await unassignHolder(jobCtxOf(t.kit), actor, t.pass.id, null);
      expect(holder).toMatchObject({
        email: t.pass.holderEmail,
        transfer: { state: 'pending', transferId: expect.any(String) },
      });
      expect(await getHolder(jobCtxOf(t.kit), t.pass.id, null)).toMatchObject({
        email: t.pass.holderEmail,
        transfer: holder.transfer,
      });
      const page = await listHolders(jobCtxOf(t.kit), {
        orgId: t.pass.orgId,
        mode: t.pass.mode,
        limit: 100,
      });
      expect(page.items.find((item) => item.passId === t.pass.id)).toMatchObject({
        email: t.pass.holderEmail,
        transfer: holder.transfer,
      });
      expect(await listWalletOffers(jobCtxOf(t.kit), t.pass.id)).toEqual([]);
      await expect(
        clearBlock(jobCtxOf(t.kit), actor, { passId: t.pass.id, userId: user.id }, null),
      ).rejects.toMatchObject({ code: 'HOLDER_TRANSFER_PENDING' });
      if (!holder.transfer) throw new Error('Missing pending transfer');
      const target = await first(
        t.kit.env.DB,
        'SELECT target_holder_email, target_owner_user_id FROM pass_credential_transfers WHERE id = ?',
        [holder.transfer.transferId],
      );
      expect(target).toEqual(
        operation === 'assign'
          ? { target_holder_email: user.primaryEmail, target_owner_user_id: user.id }
          : { target_holder_email: null, target_owner_user_id: null },
      );
    },
    120_000,
  );

  it('stages verified-email hook B without attaching before provider retirement', async () => {
    const email = 'verify-later@example.test';
    const t = await setupSamsungCallbacks({ holderEmail: email, db: await testDatabase() });
    const user = await makeUser(t.kit.fx, { primaryEmail: email });
    expect(await attachWaitingPassesForEmail(jobCtxOf(t.kit), user.id, email)).toBe(1);
    const holder = await getHolder(jobCtxOf(t.kit), t.pass.id, null);
    expect(holder).toMatchObject({
      ownerUserId: null,
      email,
      transfer: { state: 'pending', transferId: expect.any(String) },
    });
    expect(await listWalletOffers(jobCtxOf(t.kit), t.pass.id)).toEqual([]);
    expect(await attachWaitingPassesForEmail(jobCtxOf(t.kit), user.id, email)).toBe(0);
  }, 120_000);

  it('stages verified attachment through native retirement before exposing the new owner', async () => {
    const email = 'claimed@example.test';
    const t = await setupSamsungCallbacks({ holderEmail: email, db: await testDatabase() });
    const user = await makeUser(t.kit.fx, { primaryEmail: email });
    const transfer = await runAttachHookA(jobCtxOf(t.kit), t.pass.id);
    expect(transfer).toMatchObject({ state: 'pending', ownerUserId: user.id });
    expect((await getPass(t.kit.env.DB, t.pass.id))?.ownerUserId).toBeNull();
    expect(
      await first(
        t.kit.env.DB,
        'SELECT retirement_requested_at FROM wallet_provider_instances WHERE id = ?',
        [t.operation.instanceId],
      ),
    ).toEqual({ retirement_requested_at: t.kit.clock.now() });
  }, 120_000);

  it('does not permanently retire a credential for download-link rotation alone', async () => {
    const t = await setupSamsungCallbacks({ db: await testDatabase() });
    const pass = await getPass(t.kit.env.DB, t.pass.id);
    if (!pass) throw new Error('Missing pass');
    expect(
      await setDownloadToken(t.kit.env.DB, pass, t.kit.fx.ids.token(), t.kit.clock.now()),
    ).toBe(true);
    expect(
      await first(
        t.kit.env.DB,
        'SELECT retirement_requested_at FROM wallet_provider_instances WHERE id = ?',
        [t.operation.instanceId],
      ),
    ).toEqual({ retirement_requested_at: null });
  }, 120_000);
});
