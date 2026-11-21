import {
  AppleCallListSchema,
  AppleCallQuerySchema,
  WalletIdentityListQuerySchema,
  WalletIdentityListSchema,
} from '../../../shared/contracts/identities.ts';
import { ValidationError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { isPlatformAdmin, requireOrgAccess } from './access.ts';
import { listAppleCalls } from './apple-calls.ts';
import { listWalletIdentities } from './wallet-list.ts';

/** Mount at /api/v1/wallet-identities. */
export const walletIdentitiesRoutes = createRouter();

register(
  walletIdentitiesRoutes,
  'wallet identities',
  {
    method: 'get',
    path: '/',
    summary: 'List wallet identities; a member reads their own organization',
    query: WalletIdentityListQuerySchema,
    response: WalletIdentityListSchema,
    auth: { human: true, requestMode: true },
  },
  async (c) => {
    const ctx = serviceContext(c);
    const { provider: _provider, ...query } = c.req.valid('query');
    if (!isPlatformAdmin(c) && !query.orgId)
      throw new ValidationError('Choose an organization.', [], 'ORG_REQUIRED');
    await requireOrgAccess(ctx, c, query.orgId, 'integrations:read');
    return c.json(await listWalletIdentities(ctx, query));
  },
);

/** Mount at /api/v1/platform. */
export const platformAppleRoutes = createRouter();

register(
  platformAppleRoutes,
  'wallet identities',
  {
    method: 'get',
    path: '/apple-calls',
    summary: "Apple provisioner's call ledger",
    query: AppleCallQuerySchema,
    response: AppleCallListSchema,
    auth: { platform: 'platform:identities' },
  },
  async (c) => c.json(await listAppleCalls(serviceContext(c), c.req.valid('query').since)),
);
