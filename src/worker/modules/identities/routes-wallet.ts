import {
  AppleCallListSchema,
  AppleCallQuerySchema,
  WalletIdentityListQuerySchema,
  WalletIdentityListSchema,
} from '../../../shared/contracts/identities.ts';
import { UnavailableError, ValidationError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { isPlatformAdmin, requireOrgAccess } from './access.ts';
import { listAppleCalls } from './asc-ledger.ts';
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
  async (c) => {
    const ctx = serviceContext(c);
    try {
      return c.json(await listAppleCalls(ctx.env, c.req.valid('query').since));
    } catch (cause) {
      ctx.log.error('apple.calls_unavailable', {
        code: 'APPLE_PROVISIONER_UNAVAILABLE',
        message: cause instanceof Error ? cause.message : String(cause),
      });
      throw new UnavailableError(
        'The Apple provisioner is not reachable. Try again shortly.',
        'APPLE_PROVISIONER_UNAVAILABLE',
      );
    }
  },
);
