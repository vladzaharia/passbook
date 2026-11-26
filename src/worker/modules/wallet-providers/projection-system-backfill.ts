import type { ServiceContext } from '../../platform/service-context.ts';
import { publishableSchema } from './projection-contract.ts';
import { SYSTEM_AUTHORED_PROVIDERS } from './projection-system-authority.ts';
import { walletProviderReleaseState } from './provider-policy.ts';
import {
  type BackfillEnrolment,
  listBackfillEnrolments,
  listUncoveredAppleSources,
  stampBackfilled,
} from './repo-projection-backfill.ts';

const ENROLMENTS_PER_DRAIN = 5;
const PAGE = 100;
const MAX_PAGES = 20;

const MODES = ['live', 'test'] as const;
const PROVIDERS = ['google', 'samsung'] as const;

/**
 * Templates released before an enrolment was turned On, or before its mode was released, have no provider
 * candidate: candidates are otherwise queued only when an Apple release publishes. The first drain after either
 * queues one `wallet.projection_system` job per such release, then stamps the enrolment. The job is idempotent
 * and an omission that needs approval still waits for a person. A failed send leaves the enrolment unstamped.
 */
export async function backfillSystemProjections(
  ctx: ServiceContext,
  /** Tests only: a smaller page, to reach the page cap. */
  paging: { page: number; maxPages: number } = { page: PAGE, maxPages: MAX_PAGES },
): Promise<void> {
  const pairs = PROVIDERS.filter(
    (provider) => SYSTEM_AUTHORED_PROVIDERS.includes(provider) && publishableSchema(provider, 2),
  ).flatMap((provider) =>
    MODES.filter((mode) => walletProviderReleaseState(provider, mode) === 'released').map(
      (mode) => ({ provider, mode }),
    ),
  );
  if (pairs.length === 0) return;
  const startedAt = ctx.clock.now();
  const db = ctx.env.DB;
  for (const enrolment of await listBackfillEnrolments(
    db,
    pairs,
    startedAt,
    ENROLMENTS_PER_DRAIN,
  )) {
    try {
      const { count, done } = await queueBackfill(ctx, enrolment, paging);
      // Past the page cap the rest stays pending for the next drain.
      if (done) await stampBackfilled(db, enrolment.id, startedAt);
      ctx.log.info('wallet.projection_backfill_queued', {
        orgId: enrolment.orgId,
        provider: enrolment.provider,
        mode: enrolment.mode,
        count,
        done,
      });
    } catch (error) {
      ctx.log.error('wallet.projection_backfill_failed', {
        orgId: enrolment.orgId,
        code: 'WALLET_PROJECTION_BACKFILL',
        error,
      });
    }
  }
}

async function queueBackfill(
  ctx: ServiceContext,
  e: BackfillEnrolment,
  paging: { page: number; maxPages: number },
): Promise<{ count: number; done: boolean }> {
  let after = '';
  let count = 0;
  for (let page = 0; page < paging.maxPages; page++) {
    const sources = await listUncoveredAppleSources(ctx.env.DB, e, after, paging.page);
    if (sources.length > 0)
      await ctx.env.JOBS.sendBatch(
        sources.map((s) => ({
          body: {
            kind: 'wallet.projection_system' as const,
            orgId: e.orgId,
            mode: e.mode,
            templateId: s.templateId,
            sourceReleaseId: s.releaseId,
            version: s.version,
            provider: e.provider,
          },
        })),
      );
    count += sources.length;
    const last = sources.at(-1);
    if (!last || sources.length < paging.page) return { count, done: true };
    after = last.releaseId;
  }
  return { count, done: false };
}
