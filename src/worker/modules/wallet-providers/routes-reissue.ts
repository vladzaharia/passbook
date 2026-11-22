import {
  WalletReissueResponseSchema,
  WalletReissueSchema,
} from '../../../shared/contracts/wallet-provider-actions.ts';
import { modeOf } from '../../platform/auth.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import {
  assertOrg,
  authOf,
  orgIdOf,
  requireTenantSessionOrApiKey,
  svc,
  tenantAuthorityOf,
} from '../passes/http.ts';
import { startWalletReissue } from './wallet-reissue.ts';

/** Mount at /api/v1/wallet-providers/reissue. */
export const walletReissueRoutes = createRouter();
guard(walletReissueRoutes, requireTenantSessionOrApiKey('passes:write'));
walletReissueRoutes.use('*', async (c, next) => {
  await next();
  c.header('cache-control', 'no-store');
});

register(
  walletReissueRoutes,
  'wallet providers',
  {
    method: 'post',
    path: '/',
    summary:
      "Send every active Google or Samsung copy of an organization's passes again; a key needs passes:write",
    body: WalletReissueSchema,
    status: 202,
    response: WalletReissueResponseSchema,
  },
  async (c) => {
    const body = c.req.valid('json');
    const ctx = svc(c);
    const auth = authOf(c);
    const orgId = orgIdOf(auth, body.orgId);
    assertOrg(c, orgId);
    await tenantAuthorityOf(ctx, auth, orgId, 'passes:operate');
    return c.json(
      await startWalletReissue(ctx, {
        orgId,
        mode: modeOf(auth),
        provider: body.provider,
        templateId: body.templateId,
      }),
      202,
    );
  },
);
