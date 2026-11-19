import { z } from 'zod';
import { IdSchema } from '../../../shared/contracts/common.ts';
import {
  RevokeWalletCredentialSchema,
  SaveWalletCredentialSchema,
  WalletCredentialListQuerySchema,
  WalletCredentialListSchema,
  WalletCredentialParamsSchema,
  WalletCredentialSchema,
} from '../../../shared/contracts/wallet-providers.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { authOf, requireTenantSession } from '../passes/http.ts';
import {
  listOrgCredentials,
  revokeOrgCredential,
  saveOrgCredential,
} from './credential-service.ts';

/** Mount at /api/v1/orgs. `integrations:read` lists, `integrations:manage` writes; the session's mode applies. */
export const walletCredentialRoutes = createRouter();
guard(walletCredentialRoutes, requireTenantSession);
walletCredentialRoutes.use('*', async (c, next) => {
  await next();
  c.header('cache-control', 'no-store');
});

const orgParam = z.strictObject({ orgId: IdSchema });
const sessionOf = (c: Parameters<typeof authOf>[0]) => {
  const auth = authOf(c);
  if (auth.kind !== 'session') throw new UnauthenticatedError();
  return auth;
};

register(
  walletCredentialRoutes,
  'wallet credentials',
  {
    method: 'get',
    path: '/{orgId}/wallet-credentials',
    summary: 'List the organization wallet credentials of the session mode',
    params: orgParam,
    query: WalletCredentialListQuerySchema,
    response: WalletCredentialListSchema,
  },
  async (c) =>
    c.json(
      await listOrgCredentials(
        serviceContext(c),
        sessionOf(c),
        c.req.valid('param').orgId,
        c.req.valid('query').provider,
      ),
    ),
);

register(
  walletCredentialRoutes,
  'wallet credentials',
  {
    method: 'put',
    path: '/{orgId}/wallet-credentials',
    summary: 'Create or rotate the organization wallet credential',
    params: orgParam,
    body: SaveWalletCredentialSchema,
    response: WalletCredentialSchema,
  },
  async (c) =>
    c.json(
      await saveOrgCredential(
        serviceContext(c),
        sessionOf(c),
        c.req.valid('param').orgId,
        c.req.valid('json'),
      ),
    ),
);

register(
  walletCredentialRoutes,
  'wallet credentials',
  {
    method: 'post',
    path: '/{orgId}/wallet-credentials/{id}/revoke',
    summary: 'Revoke an organization wallet credential',
    params: WalletCredentialParamsSchema,
    body: RevokeWalletCredentialSchema,
    response: WalletCredentialSchema,
  },
  async (c) => {
    const { orgId, id } = c.req.valid('param');
    return c.json(
      await revokeOrgCredential(serviceContext(c), sessionOf(c), orgId, id, c.req.valid('json')),
    );
  },
);
