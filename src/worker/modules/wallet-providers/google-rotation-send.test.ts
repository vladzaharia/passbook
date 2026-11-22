// PE5c with mocks: a same-identity Google rotation moves the account revision, not its epoch, so the
// instance recorded before it still reconciles and the queued operation carries the unchanged epoch. The send
// itself, across a rotation, is covered with mocks in sync-operation.test.ts (D2).
// The unmocked run against Google needs the owner's credentials and is an owner item.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { createFixtureIdentity } from '../../../passkit/testing/fixture-identity.ts';
import { all, first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import {
  configureWalletProviderAccount,
  readConfiguredWalletProviderCredentials,
} from './account-service.ts';
import { getWalletInstanceById, readWalletPassSnapshot } from './instance.ts';
import { reconcileWalletInstance } from './lifecycle.ts';
import { setupWalletOfferKit } from './offers-test-fixtures.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { seedHistoricalProviderInstance } from './runtime-historical-fixtures.ts';
import { historicalGoogleRelease } from './runtime-integration-fixtures.ts';

beforeAll(() => {
  setWalletProvidersEnabledForTest(true);
  vi.setConfig({ testTimeout: 60_000 });
});
afterEach(() => vi.unstubAllGlobals());
const testEnv = installKeysetTestEnv();

const accountOf = (db: D1Database, id: string) =>
  first<{ revision: number; authority_epoch: number }>(
    db,
    'SELECT revision, authority_epoch FROM wallet_provider_accounts WHERE id = ?',
    [id],
  );

describe('a Google rotation, reconcile and queued send', () => {
  it('keeps the epoch, reads the new key and queues the operation with that epoch, with no network', async () => {
    const fetcher = vi.fn(() => Promise.reject(new Error('network is blocked')));
    vi.stubGlobal('fetch', fetcher);
    const f = await setupWalletOfferKit({
      google: 'configured',
      samsung: 'absent',
      db: (await testEnv()).DB,
    });
    const { kit, pass } = f;
    const db = kit.env.DB;
    const commitment = await requireCredentialRefKeyset(db, kit.env);
    const scope = { orgId: pass.orgId, mode: 'live' as const, provider: 'google' as const };
    const account = await first<{ id: string }>(
      db,
      "SELECT id FROM wallet_provider_accounts WHERE org_id = ? AND mode = 'live' AND provider = 'google'",
      [pass.orgId],
    );
    if (!account) throw new Error('Missing Google account.');
    const releaseId = await historicalGoogleRelease(f);
    const snapshot = await readWalletPassSnapshot(db, { ...scope, passId: pass.id });
    if (!snapshot) throw new Error('Missing pass snapshot.');
    const seeded = await seedHistoricalProviderInstance(db, {
      id: kit.ctx.ids.id(),
      passId: pass.id,
      orgId: pass.orgId,
      mode: 'live',
      provider: 'google',
      credentialGeneration: snapshot.credentialGeneration,
      credentialKeysetCommitment: commitment,
      accountId: account.id,
      releaseId,
      operationId: kit.ctx.ids.id(),
      now: kit.clock.now(),
      upsert: { requestHash: await sha256Hex(kit.ctx.ids.token(32)), state: 'succeeded' },
    });
    if (!seeded) throw new Error('Missing Google instance.');

    const before = await accountOf(db, account.id);
    const second = await createFixtureIdentity(undefined, { now: new Date(kit.clock.now()) });
    const rotated = await configureWalletProviderAccount(kit.ctx, f.auth, {
      ...scope,
      expectedRevision: before?.revision ?? 0,
      credentials: { ...f.google, privateKeyPem: second.privateKey },
    });
    const after = await accountOf(db, account.id);
    expect(after?.revision, 'a rotation moves the revision').toBe((before?.revision ?? 0) + 1);
    expect(after?.authority_epoch, 'a same-identity rotation keeps the epoch').toBe(
      before?.authority_epoch,
    );
    const current = await readConfiguredWalletProviderCredentials(kit.ctx, scope, {
      accountId: account.id,
      accountRevision: rotated.revision,
    });
    expect(current?.provider === 'google' && current.credentials.privateKeyPem).toBe(
      second.privateKey,
    );

    // Google issuance is dark: a historical release is not current, so the copy that reconciles is a retirement.
    await run(
      db,
      `INSERT INTO pass_channels (pass_id, org_id, mode, template_id, channel, retired_at, retired_cause,
        set_by, set_at) VALUES (?, ?, ?, ?, 'google', ?, 'pass', 'test', ?)`,
      [pass.id, pass.orgId, pass.mode, pass.templateId, kit.clock.now(), kit.clock.now()],
    );
    const instance = await getWalletInstanceById(db, { ...scope, instanceId: seeded.instanceId });
    if (!instance) throw new Error('Missing instance.');
    expect(await reconcileWalletInstance(jobCtxOf(kit), instance)).toBe('scheduled');
    const ops = await all<{ kind: string; account_epoch: number | null }>(
      db,
      `SELECT kind, account_epoch FROM wallet_provider_instance_operations
       WHERE instance_id = ? ORDER BY version DESC LIMIT 1`,
      [seeded.instanceId],
    );
    expect(ops[0]?.kind).toBe('revoke');
    expect(ops[0]?.account_epoch).toBe(after?.authority_epoch);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
