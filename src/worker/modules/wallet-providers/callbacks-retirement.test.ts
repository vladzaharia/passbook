import { beforeAll, describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { credentialRefKeysetCommitment } from '../passes/credential-keyset.ts';
import {
  ensureSamsungFetchRef,
  inspectSamsungRefRetirement,
  retireExpiredUnpromotedRef,
} from './callbacks-ref.ts';
import { replaceCallbackKeysetForTest, setupSamsungCallbacks } from './callbacks-test-fixtures.ts';
import { persistSamsungTombstone } from './callbacks-tombstone.ts';
import {
  claimWalletOperation,
  completeWalletOperation,
  newWalletClaimHandle,
  queueWalletOperation,
  readWalletPassSnapshot,
  walletClaimHash,
} from './instance.ts';
import { setWalletProvidersEnabledForTest, whileDisabledForTest } from './provider-policy.ts';
import {
  inspectSamsungRetirement,
  retireSamsungUnpromotedRef,
} from './repo-callbacks-retirement.ts';
import { putSamsungTombstone } from './repo-callbacks-tombstone.ts';
import { getProjectionRetirementMetadata } from './repo-projection.ts';

// These cases cover historical provider instances, which exist only while a provider is enabled.
beforeAll(() => {
  setWalletProvidersEnabledForTest(true);
});

describe('Samsung unpromoted reference retirement', () => {
  it('requires the captured keyset to prove an empty reference set and complete retirement', async () => {
    const t = await setupSamsungCallbacks({ reference: false });
    const db = t.kit.env.DB;
    const revoke = await queueWalletOperation(db, {
      ...t.operation,
      kind: 'revoke',
      expectedVersion: t.operation.version,
      requestKey: t.kit.ctx.ids.token(32),
      newId: () => crypto.randomUUID(),
      now: t.kit.clock.now(),
    });
    if (!revoke) throw new Error('Missing revoke fixture');
    const scope = {
      orgId: revoke.orgId,
      mode: revoke.mode,
      instanceId: revoke.instanceId,
      operationVersion: revoke.version,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
    };
    const claim = {
      orgId: revoke.orgId,
      mode: revoke.mode,
      provider: 'samsung' as const,
      instanceId: revoke.instanceId,
      version: revoke.version,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
      claimHandle: newWalletClaimHandle(),
      now: t.kit.clock.now(),
    };
    expect(await inspectSamsungRefRetirement(t.kit.ctx, scope)).toBe('no_external_card');
    expect(await claimWalletOperation(db, claim)).toBe('claimed');
    const claimHash = await walletClaimHash(claim.claimHandle);
    const oldKey = t.kit.env.KEK_V1;
    const newKey = btoa('z'.repeat(32));
    const newCommitment = await credentialRefKeysetCommitment({ ...t.kit.env, KEK_V1: newKey });
    try {
      await replaceCallbackKeysetForTest(db, newCommitment);
      t.kit.env.KEK_V1 = newKey;
      const newScope = { ...scope, credentialKeysetCommitment: newCommitment };
      expect(await inspectSamsungRetirement(db, scope, t.kit.clock.now())).toBe('pending');
      expect(await inspectSamsungRetirement(db, newScope, t.kit.clock.now())).toBe('pending');
      expect(await retireSamsungUnpromotedRef(db, scope, t.kit.clock.now(), claimHash)).toBe(
        'pending',
      );
      expect(await retireSamsungUnpromotedRef(db, newScope, t.kit.clock.now(), claimHash)).toBe(
        'pending',
      );
      await expect(inspectSamsungRefRetirement(t.kit.ctx, scope)).rejects.toMatchObject({
        code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
      });
      expect(await inspectSamsungRefRetirement(t.kit.ctx, newScope)).toBe('pending');
    } finally {
      t.kit.env.KEK_V1 = oldKey;
      await replaceCallbackKeysetForTest(db, t.credentialKeysetCommitment);
    }
    expect(
      await retireExpiredUnpromotedRef(t.kit.ctx, { ...scope, claimHandle: claim.claimHandle }),
    ).toBe('no_external_card');
    expect(
      await completeWalletOperation(t.kit.ctx, { ...claim, result: { kind: 'not_issued' } }),
    ).toBe('succeeded');
    expect(await persistSamsungTombstone(t.kit.ctx, scope)).toBe(true);
    const original = await getProjectionRetirementMetadata(db, revoke.identityProjectionReleaseId, {
      credentialKeysetCommitment: t.credentialKeysetCommitment,
    });
    if (!original) throw new Error('Missing retirement projection');
    try {
      await replaceCallbackKeysetForTest(db, newCommitment);
      t.kit.env.KEK_V1 = newKey;
      const newScope = { ...scope, credentialKeysetCommitment: newCommitment };
      expect(
        await putSamsungTombstone(db, scope, original.providerIdentityHash, t.kit.clock.now()),
      ).toBe(false);
      expect(
        await putSamsungTombstone(db, newScope, original.providerIdentityHash, t.kit.clock.now()),
      ).toBe(false);
      expect(await persistSamsungTombstone(t.kit.ctx, newScope)).toBe(false);
    } finally {
      t.kit.env.KEK_V1 = oldKey;
      await replaceCallbackKeysetForTest(db, t.credentialKeysetCommitment);
    }
  }, 120_000);

  it('waits for expiry and keeps the retired ref tombstoned without minting a replacement', async () => {
    const t = await setupSamsungCallbacks({ promoted: false });
    const db = t.kit.env.DB;
    const initial = t.operation;
    const revoke = await queueWalletOperation(db, {
      ...initial,
      kind: 'revoke',
      expectedVersion: initial.version,
      requestKey: t.kit.ctx.ids.token(32),
      newId: () => crypto.randomUUID(),
      now: t.kit.clock.now(),
    });
    if (!revoke) throw new Error('Missing revoke fixture');
    const scope = {
      orgId: revoke.orgId,
      mode: revoke.mode,
      instanceId: revoke.instanceId,
      operationVersion: revoke.version,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
    };
    expect(await inspectSamsungRefRetirement(t.kit.ctx, scope)).toBe('pending');
    t.kit.clock.advance(300_001);
    expect(await inspectSamsungRefRetirement(t.kit.ctx, scope)).toBe('no_external_card');
    const claim = {
      orgId: revoke.orgId,
      mode: revoke.mode,
      provider: 'samsung' as const,
      instanceId: revoke.instanceId,
      version: revoke.version,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
      claimHandle: newWalletClaimHandle(),
      now: t.kit.clock.now(),
    };
    expect(await claimWalletOperation(db, claim)).toBe('claimed');
    const oldKey = t.kit.env.KEK_V1;
    const newKey = btoa('z'.repeat(32));
    const newCommitment = await credentialRefKeysetCommitment({ ...t.kit.env, KEK_V1: newKey });
    try {
      await replaceCallbackKeysetForTest(db, newCommitment);
      t.kit.env.KEK_V1 = newKey;
      const claimHash = await walletClaimHash(claim.claimHandle);
      expect(await retireSamsungUnpromotedRef(db, scope, t.kit.clock.now(), claimHash)).toBe(
        'pending',
      );
      expect(
        await retireSamsungUnpromotedRef(
          db,
          { ...scope, credentialKeysetCommitment: newCommitment },
          t.kit.clock.now(),
          claimHash,
        ),
      ).toBe('pending');
      expect(
        await first(db, 'SELECT retired_at FROM wallet_samsung_fetch_refs WHERE id = ?', [
          t.referenceId,
        ]),
      ).toEqual({ retired_at: null });
    } finally {
      t.kit.env.KEK_V1 = oldKey;
      await replaceCallbackKeysetForTest(db, t.credentialKeysetCommitment);
    }
    expect(
      await retireExpiredUnpromotedRef(t.kit.ctx, {
        ...scope,
        claimHandle: newWalletClaimHandle(),
      }),
    ).toBe('pending');
    expect(
      await retireExpiredUnpromotedRef(t.kit.ctx, { ...scope, claimHandle: claim.claimHandle }),
    ).toBe('no_external_card');
    expect(
      await completeWalletOperation(t.kit.ctx, { ...claim, result: { kind: 'not_issued' } }),
    ).toBe('succeeded');
    expect(await persistSamsungTombstone(t.kit.ctx, scope)).toBe(true);
    expect((await t.call({ token: await t.token() })).status).toBe(204);
    await run(
      db,
      'UPDATE passes SET lifecycle_generation = lifecycle_generation + 1 WHERE id = ?',
      [t.pass.id],
    );
    const pass = await readWalletPassSnapshot(db, {
      orgId: scope.orgId,
      mode: scope.mode,
      passId: t.pass.id,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
    });
    if (!pass) throw new Error('Missing restored pass');
    await t.renewEvidence();
    const restored = await queueWalletOperation(db, {
      ...initial,
      kind: 'upsert',
      expectedVersion: revoke.version,
      lifecycleGeneration: pass.lifecycleGeneration,
      requestKey: t.kit.ctx.ids.token(32),
      newId: () => crypto.randomUUID(),
      now: t.kit.clock.now(),
    });
    if (!restored) throw new Error('Missing restore fixture');
    const fresh = await whileDisabledForTest(ensureSamsungFetchRef, t.kit.ctx, {
      orgId: scope.orgId,
      mode: scope.mode,
      instanceId: scope.instanceId,
      operationVersion: restored.version,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
      expiresAt: t.kit.clock.now() + 60_000,
    });
    expect(fresh).toBeNull();
    const count = await first<{ n: number }>(
      db,
      'SELECT count(*) AS n FROM wallet_samsung_fetch_refs WHERE instance_id = ?',
      [scope.instanceId],
    );
    expect(count?.n).toBe(1);
    const old = await first<{ retired_at: number | null }>(
      db,
      'SELECT retired_at FROM wallet_samsung_fetch_refs WHERE id = ?',
      [t.referenceId],
    );
    expect(old?.retired_at).not.toBeNull();
    expect((await t.call({ token: await t.token() })).status).toBe(204);
  }, 120_000);

  it('preserves an existing promoted ref across a same-holder revoke and restore', async () => {
    const t = await setupSamsungCallbacks();
    const db = t.kit.env.DB;
    const revoke = await queueWalletOperation(db, {
      ...t.operation,
      kind: 'revoke',
      expectedVersion: t.operation.version,
      requestKey: t.kit.ctx.ids.token(32),
      newId: () => crypto.randomUUID(),
      now: t.kit.clock.now(),
    });
    if (!revoke) throw new Error('Missing revoke fixture');
    const claim = {
      orgId: revoke.orgId,
      mode: revoke.mode,
      provider: 'samsung' as const,
      instanceId: revoke.instanceId,
      version: revoke.version,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
      claimHandle: newWalletClaimHandle(),
      now: t.kit.clock.now(),
    };
    expect(await claimWalletOperation(db, claim)).toBe('claimed');
    expect(
      await completeWalletOperation(t.kit.ctx, {
        ...claim,
        result: { kind: 'success', httpStatus: 200 },
      }),
    ).toBe('succeeded');
    expect(
      await persistSamsungTombstone(t.kit.ctx, {
        orgId: revoke.orgId,
        mode: revoke.mode,
        instanceId: revoke.instanceId,
        operationVersion: revoke.version,
        credentialKeysetCommitment: t.credentialKeysetCommitment,
      }),
    ).toBe(true);
    expect(
      await first(db, 'SELECT retired_at FROM wallet_samsung_fetch_refs WHERE id = ?', [
        t.referenceId,
      ]),
    ).toEqual({ retired_at: null });
    await run(
      db,
      'UPDATE passes SET lifecycle_generation = lifecycle_generation + 1 WHERE id = ?',
      [t.pass.id],
    );
    const pass = await readWalletPassSnapshot(db, {
      orgId: revoke.orgId,
      mode: revoke.mode,
      passId: t.pass.id,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
    });
    if (!pass) throw new Error('Missing restored pass');
    const restored = await queueWalletOperation(db, {
      ...t.operation,
      kind: 'upsert',
      expectedVersion: revoke.version,
      lifecycleGeneration: pass.lifecycleGeneration,
      requestKey: t.kit.ctx.ids.token(32),
      newId: () => crypto.randomUUID(),
      now: t.kit.clock.now(),
    });
    if (!restored) throw new Error('Missing restore fixture');
    const fresh = await whileDisabledForTest(ensureSamsungFetchRef, t.kit.ctx, {
      orgId: revoke.orgId,
      mode: revoke.mode,
      instanceId: revoke.instanceId,
      operationVersion: restored.version,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
      expiresAt: t.kit.clock.now() + 60_000,
    });
    expect(fresh).toBeNull();
    expect((await t.call({ token: await t.token() })).status).toBe(200);
  }, 120_000);
});
