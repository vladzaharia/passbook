import { describe, expect, it } from 'vitest';
import { first } from '../../platform/db.ts';
import { setupSamsungChannelOff } from './channel-off-test-fixtures.ts';
import { getWalletInstance, getWalletOperation } from './instance.ts';
import { reconcileWalletInstance } from './lifecycle.ts';

const setup = setupSamsungChannelOff;

describe('Samsung and Google channel_off retirement', () => {
  it('stages nothing without a retired marker (a kill switch never sets one)', async () => {
    const t = await setup();
    const before = await t.instance();
    await reconcileWalletInstance(t.kit.ctx, before);
    expect(await t.instance()).toMatchObject({
      retirementRequestedAt: null,
      retirementCause: null,
      channelEpoch: 1,
    });
    await t.marker(null);
    await reconcileWalletInstance(t.kit.ctx, await t.instance());
    expect(await t.instance()).toMatchObject({ retirementRequestedAt: null });
  });

  it('turns a retired marker into a revoke with the channel_off cause', async () => {
    const t = await setup();
    await t.marker(t.kit.clock.now());
    expect(await reconcileWalletInstance(t.kit.ctx, await t.instance())).toBe('scheduled');
    const staged = await t.instance();
    expect(staged).toMatchObject({
      retirementCause: 'channel_off',
      lifecycle: 'revoking',
      retirementRequestedAt: expect.any(Number),
    });
    const revoke = await getWalletOperation(t.db, {
      ...t.scope,
      instanceId: staged.id,
      version: staged.desiredVersion,
    });
    expect(revoke).toMatchObject({ kind: 'revoke', channelEpoch: 1 });
    // A second pass is idempotent: the cause and request time are write-once.
    await reconcileWalletInstance(t.kit.ctx, await t.instance());
    expect(await t.instance()).toMatchObject({
      retirementRequestedAt: staged.retirementRequestedAt,
      desiredVersion: staged.desiredVersion,
    });
  });

  it('retires a Samsung copy once its tombstones exist', async () => {
    const t = await setup();
    await t.turnOffAndRetire();
    expect(await t.instance()).toMatchObject({
      lifecycle: 'retired',
      retirementCause: 'channel_off',
    });
  });

  it('creates a born-active successor at epoch 2 after the predecessor settles', async () => {
    const t = await setup();
    await t.turnOffAndRetire();
    const predecessor = await t.instance();
    expect((await getWalletInstance(t.db, { ...t.scope, passId: t.pass.id }))?.id).toBe(
      predecessor.id,
    );
    const input = await t.successorInput();
    // The channel is still off: the successor is refused (trigger and statement guard agree).
    await t.insertInstance(input);
    expect(await t.instanceCount()).toBe(1);

    await t.marker(null);
    await t.insertInstance(input);
    expect(await t.instanceCount()).toBe(2);
    expect(
      await getWalletOperation(t.db, { ...t.scope, instanceId: input.instanceId, version: 1 }),
    ).toMatchObject({ id: input.operationId, kind: 'upsert', channelEpoch: 2 });
    const successor = await t.instance(input.instanceId);
    expect(successor).toMatchObject({
      lifecycle: 'active',
      channelEpoch: 2,
      credentialGeneration: predecessor.credentialGeneration,
      retirementCause: null,
      desiredOperationId: input.operationId,
    });
    // The slot names the successor; the predecessor keeps its own identity and tombstones.
    expect((await getWalletInstance(t.db, { ...t.scope, passId: t.pass.id }))?.id).toBe(
      input.instanceId,
    );
    expect(await t.instance()).toMatchObject({ lifecycle: 'retired', channelEpoch: 1 });
    const refs = await first<{ n: number }>(
      t.db,
      'SELECT COUNT(*) AS n FROM wallet_samsung_fetch_refs WHERE instance_id = ?',
      [input.instanceId],
    );
    expect(refs?.n).toBe(0);

    // Turning it off again retires the successor through the same path.
    await t.marker(t.kit.clock.now());
    expect(await reconcileWalletInstance(t.kit.ctx, successor)).toBe('scheduled');
    expect(await t.instance(input.instanceId)).toMatchObject({
      retirementCause: 'channel_off',
      channelEpoch: 2,
    });
  });

  it('refuses a successor while the predecessor is still revoking', async () => {
    const t = await setup();
    await t.marker(t.kit.clock.now());
    await reconcileWalletInstance(t.kit.ctx, await t.instance());
    await t.marker(null);
    expect(await t.instance()).toMatchObject({ lifecycle: 'revoking' });
    await t.insertInstance(await t.successorInput());
    expect(await t.instanceCount()).toBe(1);
  });
});
