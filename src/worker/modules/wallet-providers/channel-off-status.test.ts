import { OpenAPIHono } from '@hono/zod-openapi';
import { describe, expect, it } from 'vitest';
import { WalletProviderPassStatusSchema } from '../../../shared/contracts/wallet-provider-status.ts';
import { type AppBindings, requestContext } from '../../platform/context.ts';
import { handleError } from '../../platform/error-handler.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { eventMember, eventStores } from '../events/test-auth-fixtures.ts';
import {
  finishCredentialTransfer,
  startCredentialTransfer,
} from '../passes/credential-transfer.ts';
import { setupSamsungChannelOff } from './channel-off-test-fixtures.ts';
import { getWalletInstance } from './instance.ts';
import { walletProviderStatusRoutes } from './routes-status.ts';

async function statusOf(t: Awaited<ReturnType<typeof setupSamsungChannelOff>>) {
  const member = await eventMember(t.kit, t.kit.org.id, ['read_only']);
  const app = new OpenAPIHono<AppBindings>();
  app.use('*', requestContext({ stores: eventStores(t.kit), clock: t.kit.clock }));
  app.onError(handleError);
  app.route('/api/v1/wallet-providers/passes', walletProviderStatusRoutes);
  const response = await app.request(
    `https://wallet.test/api/v1/wallet-providers/passes/${t.pass.id}`,
    { headers: member.session.headers },
    t.kit.env,
  );
  expect(response.status).toBe(200);
  return WalletProviderPassStatusSchema.parse(await response.json());
}

describe('one slot per provider after a channel-off', () => {
  it('reports the successor, one row per provider, once it replaces the retired copy', async () => {
    const t = await setupSamsungChannelOff();
    await t.turnOffAndRetire();
    const retired = await statusOf(t);
    expect(retired.providers).toHaveLength(2);
    expect(retired.providers[1]).toMatchObject({ provider: 'samsung', lifecycle: 'retired' });

    await t.marker(null);
    await t.insertInstance(await t.successorInput());
    const replaced = await statusOf(t);
    expect(replaced.providers.map((p) => p.provider)).toEqual(['google', 'samsung']);
    expect(replaced.providers[1]).toMatchObject({ lifecycle: 'active' });
  });

  it('lets a holder transfer proceed past a retired channel_off copy, with placeholders at epoch 1', async () => {
    const t = await setupSamsungChannelOff();
    await t.turnOffAndRetire();
    const transfer = await startCredentialTransfer(
      jobCtxOf(t.kit),
      { type: 'system', id: null },
      t.pass.id,
      { holderEmail: 'next-holder@example.test', ownerUserId: null },
      null,
      { kind: 'tenant-holder', expected: t.pass },
    );
    expect((await finishCredentialTransfer(jobCtxOf(t.kit), transfer.transferId)).state).toBe(
      'completed',
    );
    const next = await getWalletInstance(t.db, { ...t.scope, passId: t.pass.id });
    expect(next).toMatchObject({
      lifecycle: 'ready',
      channelEpoch: 1,
      retirementCause: null,
      credentialGeneration: t.operation.credentialGeneration + 1,
    });
    expect(await t.instance()).toMatchObject({
      lifecycle: 'retired',
      retirementCause: 'channel_off',
    });
  });
});
