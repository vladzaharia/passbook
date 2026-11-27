import {
  WalletReissueResponseSchema,
  WalletReissueSchema,
} from '../../../shared/contracts/wallet-provider-actions.ts';
import { modeOf } from '../../platform/auth.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { recordAudit } from '../audit/service.ts';
import { actorOfAuth } from '../operations/start-org.ts';
import {
  actorFor,
  assertOrg,
  authOf,
  orgIdOf,
  requireTenantSessionOrApiKey,
  svc,
  tenantAuthorityOf,
} from '../passes/http.ts';
import { assertWalletProviderEnabled } from './provider-policy.ts';
import { limitReissues } from './reissue-limit.ts';
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
    const mode = modeOf(auth);
    // A dark provider has no copies: say so, instead of an answer of zero.
    assertWalletProviderEnabled(body.provider, mode);
    await limitReissues(ctx, auth.kind === 'api_key' ? auth.keyId : null, orgId);
    const started = await startWalletReissue(
      ctx,
      {
        orgId,
        mode,
        provider: body.provider,
        templateId: body.templateId,
      },
      { actor: actorOfAuth(auth) },
    );
    const actor = actorFor(c);
    await recordAudit(ctx, {
      orgId,
      actorType: actor.type,
      actorId: actor.id,
      action: 'wallet.reissue',
      targetType: 'org',
      targetId: orgId,
      detail: { provider: body.provider, instances: started.instances },
    });
    return c.json(started, 202);
  },
);
