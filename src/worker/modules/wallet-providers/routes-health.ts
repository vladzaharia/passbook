import { z } from 'zod';
import { IdSchema } from '../../../shared/contracts/common.ts';
import {
  WalletHealthListSchema,
  WalletHealthParamsSchema,
  WalletRecheckResultSchema,
} from '../../../shared/contracts/wallet-health.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { actorFor, authOf } from '../passes/http.ts';
import { listWalletHealth, recheckUncertain } from './health.ts';

/** Mounted by `routes-enrolments.ts` under /api/v1/orgs, behind its tenant session guard. */
export const walletHealthRoutes = createRouter();

const sessionOf = (c: Parameters<typeof authOf>[0]) => {
  const auth = authOf(c);
  if (auth.kind !== 'session') throw new UnauthenticatedError();
  return auth;
};

register(
  walletHealthRoutes,
  'wallet health',
  {
    method: 'get',
    path: '/{orgId}/wallet-health',
    summary: 'Health of the wallets open to an organization, in the session mode',
    params: z.strictObject({ orgId: IdSchema }),
    response: WalletHealthListSchema,
  },
  async (c) =>
    c.json(await listWalletHealth(serviceContext(c), sessionOf(c), c.req.valid('param').orgId)),
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
  },
  async (c) => {
    const { orgId, provider } = c.req.valid('param');
    const ctx = serviceContext(c);
    const result = await recheckUncertain(ctx, sessionOf(c), orgId, provider);
    const actor = actorFor(c);
    await recordAudit(ctx, {
      orgId,
      actorType: actor.type,
      actorId: actor.id,
      action: 'wallet.uncertain_recheck',
      targetType: 'org',
      targetId: orgId,
      detail: { provider, queued: result.queued },
    });
    return c.json(result, 202);
  },
);
