import { describe, expect, it, vi } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { first, run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { attachWaitingPassesForEmail, reassignHolder } from '../holders/service.ts';
import { removePassFromUser } from '../holders/service-remove.ts';
import { ownerSessionId } from '../holders/test-auth-fixtures.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { finishCredentialTransfer } from '../passes/credential-transfer.ts';
import { setupKit } from '../passes/pass-test-fixtures.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { setupSamsungCallbacks } from '../wallet-providers/callbacks-test-fixtures.ts';
import {
  claimWalletOperation,
  completeWalletOperation,
  getWalletInstanceById,
  newWalletClaimHandle,
} from '../wallet-providers/instance.ts';
import { reconcileWalletInstance } from '../wallet-providers/lifecycle.ts';
import * as walletOffers from '../wallet-providers/offers.ts';
import { makeProviderTestTemplate } from '../wallet-providers/offers-test-fixtures.ts';
import { finishWalletProviderRetirement } from '../wallet-providers/sync-operation-retirement.ts';
import { myPassesBundle } from './bundle.ts';
import { getMyPass, listMyPasses, removeMyPass } from './service.ts';

const ORIGIN = 'https://wallet.test';
// Storage lasts for the whole file; the credential keyset is immutable, so each case gets its own D1.
const makeEnv = installKeysetTestEnv();
const setupProviderKit = async () => {
  const kit = await setupKit({ db: (await makeEnv()).DB, template: makeProviderTestTemplate });
  return kit;
};

async function ownedWithProvider() {
  const kit = await setupProviderKit();
  const user = await makeUser(kit.fx);
  const apple = await approveAppleRelease(kit);
  const pass = await kit.pass({ holderEmail: user.primaryEmail });
  await setupSamsungCallbacks({ source: { kit, apple, pass, barcode: 'none' } });
  return { kit, user, pass };
}

describe('self-removal credential transfers', () => {
  it('reports pending until retirement completes, fences old access and prevents re-attachment', async () => {
    const email = 'self-remove@example.test';
    const kit = await setupProviderKit();
    const user = await makeUser(kit.fx, { primaryEmail: email });
    const apple = await approveAppleRelease(kit);
    const pass = await kit.pass({ holderEmail: email });
    const t = await setupSamsungCallbacks({ source: { kit, apple, pass, barcode: 'none' } });
    const stranger = await makeUser(kit.fx);
    const session = await makeSession(kit.fx, { userId: user.id });
    const other = await makeSession(kit.fx, { userId: stranger.id });
    const before = await getPass(kit.env.DB, t.pass.id);
    if (!before) throw new Error('Missing pass');
    const bundleId = kit.fx.ids.id();
    await run(
      kit.env.DB,
      "INSERT INTO bundles (id, org_id, name, token, created_at) VALUES (?, ?, 'B', ?, 1)",
      [bundleId, t.pass.orgId, kit.fx.ids.token()],
    );
    await run(
      kit.env.DB,
      'INSERT INTO bundle_passes (bundle_id, pass_id, position) VALUES (?, ?, 0)',
      [bundleId, t.pass.id],
    );

    const app = createApp({
      clock: kit.clock,
      stores: { ...denyAllStores, sessions: createSessionStore(kit.env, kit.clock) },
    });
    const call = (path: string, headers = session.headers, method = 'GET') =>
      app.request(`${ORIGIN}${path}`, { method, headers }, kit.env);
    const passPath = `/api/v1/me/passes/${t.pass.id}`;
    const removed = await call(passPath, session.headers, 'DELETE');
    expect(removed.status).toBe(202);
    const result = (await removed.json()) as { transferId: string; state: string };
    expect(result).toEqual({ transferId: expect.any(String), state: 'pending' });
    const receiptPath = `/api/v1/me/pass-removals/${result.transferId}`;
    expect(await (await call(receiptPath)).json()).toEqual(result);
    expect((await call(receiptPath, other.headers)).status).toBe(404);
    expect((await call(receiptPath, {})).status).toBe(401);
    expect((await call(passPath, session.headers, 'DELETE')).status).toBe(409);
    expect((await call(passPath)).status).toBe(404);
    expect((await call(`${passPath}/barcode`)).status).toBe(404);
    expect((await call('/api/v1/me/passes.pkpasses')).status).toBe(404);

    const pendingPass = await getPass(kit.env.DB, t.pass.id);
    if (!pendingPass) throw new Error('Missing pending pass');
    expect(pendingPass.ownerUserId).toBe(user.id);
    expect(pendingPass.downloadToken).not.toBe(before.downloadToken);
    const listText = await (await call('/api/v1/me/passes')).text();
    expect(JSON.parse(listText)).toMatchObject({
      items: [],
      pendingRemovals: [{ passId: t.pass.id, transferId: result.transferId }],
    });
    expect(listText).not.toContain(before.downloadToken);
    expect(listText).not.toContain(pendingPass.downloadToken);
    expect(listText).not.toContain(before.authToken);
    if (before.scanCode) expect(listText).not.toContain(before.scanCode);
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM bundle_passes WHERE bundle_id = ?', [bundleId]),
    ).toBeNull();
    expect(
      await first(
        kit.env.DB,
        'SELECT 1 FROM pass_attach_blocks WHERE pass_id = ? AND user_id = ?',
        [t.pass.id, user.id],
      ),
    ).not.toBeNull();
    expect(await attachWaitingPassesForEmail(jobCtxOf(kit), user.id, email)).toBe(0);
    expect(
      await first(
        kit.env.DB,
        `SELECT actor_type, actor_id FROM audit_log
      WHERE action = 'pass.remove_from_user' AND target_id = ?`,
        [t.pass.id],
      ),
    ).toEqual({ actor_type: 'user', actor_id: user.id });
    expect(await finishCredentialTransfer(jobCtxOf(kit), result.transferId)).toEqual(result);

    const scope = {
      orgId: t.pass.orgId,
      mode: t.pass.mode,
      provider: 'samsung' as const,
      instanceId: t.operation.instanceId,
    };
    const old = await getWalletInstanceById(kit.env.DB, scope);
    if (!old) throw new Error('Missing wallet incarnation');
    expect(await reconcileWalletInstance(jobCtxOf(kit), old)).toBe('scheduled');
    const retiring = await getWalletInstanceById(kit.env.DB, scope);
    if (!retiring) throw new Error('Missing retiring incarnation');
    const claim = {
      ...scope,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
      version: retiring.desiredVersion,
      claimHandle: newWalletClaimHandle(),
      now: kit.clock.now(),
    };
    expect(await claimWalletOperation(kit.env.DB, claim)).toBe('claimed');
    expect(
      await completeWalletOperation(jobCtxOf(kit), {
        ...claim,
        result: { kind: 'success', httpStatus: 200 },
      }),
    ).toBe('succeeded');
    expect(await finishWalletProviderRetirement(jobCtxOf(kit), claim)).toBe(true);
    expect(await finishCredentialTransfer(jobCtxOf(kit), result.transferId)).toEqual({
      transferId: result.transferId,
      state: 'completed',
    });
    expect(await (await call(receiptPath)).json()).toEqual({
      transferId: result.transferId,
      state: 'completed',
    });
    expect(await (await call('/api/v1/me/passes')).json()).toMatchObject({
      items: [],
      pendingRemovals: [],
    });
    const after = await getPass(kit.env.DB, t.pass.id);
    expect(after?.ownerUserId).toBeNull();
    expect(after?.serial).not.toBe(before.serial);
    expect(after?.authToken).not.toBe(before.authToken);
    expect(after?.scanCode).not.toBe(before.scanCode);
    expect(await attachWaitingPassesForEmail(jobCtxOf(kit), user.id, email)).toBe(0);
    expect((await getPass(kit.env.DB, t.pass.id))?.ownerUserId).toBeNull();
  }, 120_000);

  it('returns completed only after an immediately settled removal', async () => {
    const kit = await setupProviderKit();
    const user = await makeUser(kit.fx);
    const pass = await kit.pass({ holderEmail: user.primaryEmail });
    const session = await makeSession(kit.fx, { userId: user.id });
    const app = createApp({
      clock: kit.clock,
      stores: { ...denyAllStores, sessions: createSessionStore(kit.env, kit.clock) },
    });
    const response = await app.request(
      `${ORIGIN}/api/v1/me/passes/${pass.id}`,
      { method: 'DELETE', headers: session.headers },
      kit.env,
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as { transferId: string; state: string };
    expect(result).toEqual({ transferId: expect.any(String), state: 'completed' });
    expect((await getPass(kit.env.DB, pass.id))?.ownerUserId).toBeNull();
    const receipt = await app.request(
      `${ORIGIN}/api/v1/me/pass-removals/${result.transferId}`,
      { headers: session.headers },
      kit.env,
    );
    expect(await receipt.json()).toEqual(result);
  }, 120_000);

  it('fences an archive object when a transfer starts while its bytes are read', async () => {
    const { kit, user, pass } = await ownedWithProvider();
    let changed = false;
    const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
    const get = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (key, options) => {
      const object = await originalGet(key, options);
      if (key === pass.objectKey && !changed) {
        changed = true;
        expect(
          (
            await removePassFromUser(
              jobCtxOf(kit),
              pass.id,
              user.id,
              await ownerSessionId(kit, user.id),
            )
          ).state,
        ).toBe('pending');
        expect((await getPass(kit.env.DB, pass.id))?.ownerUserId).toBe(user.id);
      }
      return object;
    });
    try {
      const bundle = await myPassesBundle(jobCtxOf(kit), user.id, 1);
      await expect(new Response(bundle.body).arrayBuffer()).rejects.toMatchObject({
        code: 'PASS_NOT_FOUND',
      });
    } finally {
      get.mockRestore();
    }
  }, 120_000);

  it.each(['list', 'detail'] as const)(
    'does not return a stale %s DTO after the credential generation changes',
    async (surface) => {
      const { kit, user, pass } = await ownedWithProvider();
      let changed = false;
      const lookup = vi.spyOn(walletOffers, 'listWalletOffers').mockImplementation(async () => {
        if (!changed) {
          changed = true;
          expect(
            (
              await removePassFromUser(
                jobCtxOf(kit),
                pass.id,
                user.id,
                await ownerSessionId(kit, user.id),
              )
            ).state,
          ).toBe('pending');
          expect((await getPass(kit.env.DB, pass.id))?.ownerUserId).toBe(user.id);
        }
        return [];
      });
      try {
        if (surface === 'list') {
          const result = await listMyPasses(jobCtxOf(kit), user.id, { limit: 50 });
          expect(result.items).toEqual([]);
          expect(JSON.stringify(result)).not.toContain(pass.downloadToken);
        } else {
          await expect(getMyPass(jobCtxOf(kit), user.id, pass.id)).rejects.toMatchObject({
            status: 404,
          });
        }
        expect(lookup).toHaveBeenCalled();
      } finally {
        lookup.mockRestore();
      }
    },
    120_000,
  );

  it.each(['different owner', 'same owner again'] as const)(
    'does not report success when a stale holder CAS sees %s',
    async (race) => {
      const kit = await setupProviderKit();
      const user = await makeUser(kit.fx);
      const other = await makeUser(kit.fx);
      const pass = await kit.pass({ holderEmail: user.primaryEmail });
      await expect(
        removeMyPass(jobCtxOf(kit), user.id, await ownerSessionId(kit, user.id), pass.id, {
          requestRefresh: async () => {
            throw new Error('Unexpected refresh');
          },
          removePassFromUser: async (ctx, passId, userId, sessionId, expected) => {
            await reassignHolder(
              ctx,
              { type: 'system', id: null },
              { passId, email: other.primaryEmail },
              null,
            );
            if (race === 'same owner again') {
              await reassignHolder(
                ctx,
                { type: 'system', id: null },
                { passId, email: user.primaryEmail },
                null,
              );
            }
            return removePassFromUser(ctx, passId, userId, sessionId, expected);
          },
        }),
      ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM pass_attach_blocks WHERE pass_id = ?', [pass.id]),
      ).toBeNull();
      expect(
        await first(
          kit.env.DB,
          `SELECT 1 FROM pass_credential_transfers
        WHERE pass_id = ? AND requested_by_type = 'user' AND requested_by_id = ?`,
          [pass.id, user.id],
        ),
      ).toBeNull();
      expect(
        await first(
          kit.env.DB,
          "SELECT 1 FROM audit_log WHERE action = 'pass.remove_from_user' AND target_id = ?",
          [pass.id],
        ),
      ).toBeNull();
    },
    120_000,
  );
});
