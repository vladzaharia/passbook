import { IdParamSchema } from '../../../shared/contracts/common.ts';
import { WalletProviderPassStatusSchema } from '../../../shared/contracts/wallet-provider-status.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { authOf, passScopeOf, requireTenantSessionOrApiKey, svc } from '../passes/http.ts';
import { getWalletProviderPassStatus } from './status.ts';

/** Mount at /api/v1/wallet-providers/passes. */
export const walletProviderStatusRoutes = createRouter();
walletProviderStatusRoutes.use('*', async (c, next) => {
  c.header('cache-control', 'no-store');
  await next();
});
guard(walletProviderStatusRoutes, requireTenantSessionOrApiKey('passes:read'));

register(
  walletProviderStatusRoutes,
  'wallet providers',
  {
    method: 'get',
    path: '/{id}',
    summary: 'Get local provider instance status for a pass',
    params: IdParamSchema,
    response: WalletProviderPassStatusSchema,
  },
  async (c) =>
    c.json(
      await getWalletProviderPassStatus(svc(c), authOf(c), c.req.valid('param').id, passScopeOf(c)),
    ),
);
