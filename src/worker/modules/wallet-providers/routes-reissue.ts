import {
  WalletReissueResponseSchema,
  WalletReissueSchema,
} from '../../../shared/contracts/wallet-provider-actions.ts';
import { modeOf } from '../../platform/auth.ts';
import { bump } from '../../platform/counters.ts';
import { RateLimitedError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { recordAudit } from '../audit/service.ts';
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
import { startWalletReissue } from './wallet-reissue.ts';

const REISSUES_PER_KEY_HOUR = 6;
const REISSUES_PER_ORG_HOUR = 12;
const HOUR_MS = 60 * 60_000;

/** Like the Apple twin (passes/routes-bulk.ts): a key starts six an hour, and an org twelve whoever asks. */
async function limitReissues(ctx: ReturnType<typeof svc>, keyId: string | null, orgId: string) {
  const now = ctx.clock.now();
  const window = Math.floor(now / HOUR_MS) * HOUR_MS;
  const retry = Math.ceil((window + HOUR_MS - now) / 1000);
  if (
    keyId &&
    (await bump(ctx.env.DB, `wallet-reissue:key:${keyId}`, window)) > REISSUES_PER_KEY_HOUR
  )
    throw new RateLimitedError(retry);
  if ((await bump(ctx.env.DB, `wallet-reissue:org:${orgId}`, window)) > REISSUES_PER_ORG_HOUR)
    throw new RateLimitedError(retry);
}

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
    const started = await startWalletReissue(ctx, {
      orgId,
      mode,
      provider: body.provider,
      templateId: body.templateId,
    });
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
