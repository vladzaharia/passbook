import {
  ConfigureWalletProviderAccountSchema,
  RevokeWalletProviderAccountSchema,
  WalletProviderReadinessSchema,
  WalletProviderScopeSchema,
} from '../../../shared/contracts/wallet-providers.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { authOf, requireTenantSession } from '../passes/http.ts';
import {
  configureWalletProviderAccount,
  getWalletProviderAccount,
  revokeWalletProviderAccount,
} from './account-service.ts';
import { samsungVerificationRoutes } from './samsung-verification-routes.ts';

/** Mount at /api/v1/wallet-providers/accounts. Requires a tenant session and CSRF for writes. */
export const walletProviderAccountRoutes = createRouter();
guard(walletProviderAccountRoutes, requireTenantSession);
walletProviderAccountRoutes.use('*', async (c, next) => {
  await next();
  c.header('cache-control', 'no-store');
});
walletProviderAccountRoutes.route('/', samsungVerificationRoutes);

register(
  walletProviderAccountRoutes,
  'wallet providers',
  {
    method: 'get',
    path: '/',
    summary: 'Get provider account readiness',
    query: WalletProviderScopeSchema,
    response: WalletProviderReadinessSchema,
  },
  async (c) => {
    const auth = authOf(c);
    if (auth.kind !== 'session') throw new UnauthenticatedError();
    return c.json(await getWalletProviderAccount(serviceContext(c), auth, c.req.valid('query')));
  },
);

register(
  walletProviderAccountRoutes,
  'wallet providers',
  {
    method: 'put',
    path: '/',
    summary: 'Configure or rotate a provider account',
    body: ConfigureWalletProviderAccountSchema,
    response: WalletProviderReadinessSchema,
  },
  async (c) => {
    const auth = authOf(c);
    if (auth.kind !== 'session') throw new UnauthenticatedError();
    return c.json(
      await configureWalletProviderAccount(serviceContext(c), auth, c.req.valid('json')),
    );
  },
);

register(
  walletProviderAccountRoutes,
  'wallet providers',
  {
    method: 'post',
    path: '/revoke',
    summary: 'Revoke a provider account',
    body: RevokeWalletProviderAccountSchema,
    response: WalletProviderReadinessSchema,
  },
  async (c) => {
    const auth = authOf(c);
    if (auth.kind !== 'session') throw new UnauthenticatedError();
    return c.json(await revokeWalletProviderAccount(serviceContext(c), auth, c.req.valid('json')));
  },
);
