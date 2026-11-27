import type {
  WalletHealth,
  WalletHealthList,
  WalletRecheckResult,
} from '../../../shared/contracts/wallet-health.ts';
import type { WalletProvider } from '../../../shared/contracts/wallet-providers.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { bump } from '../../platform/counters.ts';
import { RateLimitedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { settleWalletClaim } from './instance.ts';
import type { WalletMode } from './instance-types.ts';
import { assertWalletProviderEnabled, walletProviderIssuance } from './provider-policy.ts';
import { accountCheckFailing } from './repo-account-health.ts';
import { enrolmentsOf } from './repo-enrolments.ts';
import { readWalletHealthRows } from './repo-health.ts';
import { listOrgUncertainOperations } from './repo-sync-uncertain.ts';

const PROVIDERS: WalletProvider[] = ['google', 'samsung'];
const RECHECK_LIMIT = 50;

/**
 * Health of the wallets that are open to the organization in the session mode. A wallet that is not
 * released is left out, not reported as off.
 */
export async function listWalletHealth(
  ctx: ServiceContext,
  auth: SessionAuth,
  orgId: string,
): Promise<WalletHealthList> {
  await tenantAuthorityOf(ctx, auth, orgId, 'integrations:read');
  const now = ctx.clock.now();
  const [rows, enrolments] = await Promise.all([
    readWalletHealthRows(ctx.env.DB, orgId, auth.mode, now),
    enrolmentsOf(ctx.env.DB, orgId, auth.mode),
  ]);
  const items: WalletHealth[] = [];
  for (const provider of PROVIDERS) {
    if (walletProviderIssuance(provider, auth.mode).state !== 'enabled') continue;
    const row = rows.find((r) => r.provider === provider);
    const account = enrolments.find((e) => e.provider === provider);
    const failing = account ? await accountCheckFailing(ctx.env.DB, account.id) : false;
    const counts = row ?? {
      lastSuccessAt: null,
      queued: 0,
      failed24h: 0,
      uncertain: 0,
      uncertainWaiting: 0,
      callbackAt: null,
    };
    items.push({
      provider,
      mode: auth.mode,
      tone: failing
        ? 'failing'
        : counts.failed24h > 0 || counts.uncertain > 0
          ? 'attention'
          : counts.lastSuccessAt === null && counts.queued === 0
            ? 'idle'
            : 'ok',
      lastSuccessAt: counts.lastSuccessAt,
      queued: counts.queued,
      failed24h: counts.failed24h,
      uncertain: counts.uncertain,
      uncertainWaiting: counts.uncertainWaiting,
      callbackAt: counts.callbackAt,
    });
  }
  return { items };
}

/** Hourly cap per wallet: a recheck is idempotent, so this only keeps a held button from flooding the queue. */
const RECHECKS_PER_HOUR = 10;

/**
 * Queue the settling of the organization's uncertain updates that are past the grace window: the sweeper's own
 * step, started now for one wallet. An update still inside the window is left alone, since the first attempt
 * may be in flight. The job holds the write: no request grant reaches the provider queue.
 */
export async function recheckUncertain(
  ctx: ServiceContext,
  auth: SessionAuth,
  orgId: string,
  provider: WalletProvider,
): Promise<WalletRecheckResult> {
  await tenantAuthorityOf(ctx, auth, orgId, 'passes:operate');
  assertWalletProviderEnabled(provider, auth.mode);
  const now = ctx.clock.now();
  const hour = 3_600_000;
  const key = `walletrecheck:${orgId}:${auth.mode}:${provider}`;
  if ((await bump(ctx.env.DB, key, Math.floor(now / hour) * hour)) > RECHECKS_PER_HOUR)
    throw new RateLimitedError();
  const due = await listOrgUncertainOperations(ctx.env.DB, {
    orgId,
    mode: auth.mode,
    provider,
    now,
    limit: RECHECK_LIMIT,
  });
  if (due.length > 0)
    await ctx.env.JOBS.send({ kind: 'wallet.uncertain_recheck', orgId, mode: auth.mode, provider });
  const health = (await listWalletHealth(ctx, auth, orgId)).items.find(
    (h) => h.provider === provider,
  );
  return { queued: due.length, waiting: health?.uncertainWaiting ?? 0 };
}

/** The job: settle what is past the window, with the sweeper's own step. */
export async function runUncertainRecheck(
  ctx: ServiceContext,
  job: { orgId: string; mode: WalletMode; provider: WalletProvider },
): Promise<number> {
  const now = ctx.clock.now();
  const due = await listOrgUncertainOperations(ctx.env.DB, { ...job, now, limit: RECHECK_LIMIT });
  let settled = 0;
  for (const op of due) if (await settleWalletClaim(ctx, { ...op, now })) settled += 1;
  ctx.log.info('wallet.uncertain_rechecked', {
    orgId: job.orgId,
    code: 'WALLET_UNCERTAIN_RECHECKED',
    settled,
  });
  return settled;
}
