import { z } from 'zod';
import { IdSchema } from '../../../shared/contracts/common.ts';
import {
  WalletHealthListSchema,
  WalletHealthParamsSchema,
  WalletRecheckResultSchema,
} from '../../../shared/contracts/wallet-health.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { actorFor, authOf } from '../passes/http.ts';
import { listWalletHealth, recheckUncertain } from './health.ts';

/** Mount at /api/v1/orgs, ahead of the session-only org routes. A key needs `wallet:read` to read and `passes:write` to recheck. */
export const walletHealthRoutes = createRouter();
walletHealthRoutes.use('*', async (c, next) => {
  await next();
  c.header('cache-control', 'no-store');
});

register(
  walletHealthRoutes,
  'wallet health',
  {
    method: 'get',
    path: '/{orgId}/wallet-health',
    summary: "Health of the wallets open to an organization, in the caller's mode",
    params: z.strictObject({ orgId: IdSchema }),
    response: WalletHealthListSchema,
    auth: { scope: 'wallet:read', capability: 'integrations:read' },
  },
  async (c) =>
    c.json(await listWalletHealth(serviceContext(c), authOf(c), c.req.valid('param').orgId)),
);

register(
  walletHealthRoutes,
  'wallet health',
  {
    method: 'post',
    path: '/{orgId}/wallet-health/{provider}/recheck',
    summary: "Queue the settling of a wallet's uncertain updates that are past their grace window",
    status: 202,
    params: WalletHealthParamsSchema,
    response: WalletRecheckResultSchema,
    auth: { scope: 'passes:write', capability: 'passes:operate' },
  },
  async (c) => {
    const { orgId, provider } = c.req.valid('param');
    const ctx = serviceContext(c);
    const result = await recheckUncertain(ctx, authOf(c), orgId, provider);
    const actor = actorFor(c);
    await recordAudit(ctx, {
      orgId,
      actorType: actor.type,
      actorId: actor.id,
      action: 'wallet.uncertain_recheck',
      targetType: 'org',
      targetId: orgId,
      detail: { provider, due: result.due },
    });
    return c.json(result, 202);
  },
);
