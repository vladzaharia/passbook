import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight } from 'lucide-react';
import { z } from 'zod';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import { WB_PASSES } from '@/shared/copy/workbench-passes.ts';
import { wbEventsPath, wbPath } from '@/shared/workbench.ts';
import { SyncTab } from '../../admin/passes/detail/sync-tab.tsx';
import { pollEvery } from '../../lib/poll-backoff.ts';
import { useToolApi, useToolKey } from '../../lib/tool-api.tsx';
import { Skeleton } from '../../ui/skeleton.tsx';
import { BenchTime } from '../bench/time.tsx';
import { WbLink } from '../logs/link.tsx';
import { ToolFailed } from '../states/states.tsx';
import { TAB_POLL_MS } from './use-passes.ts';

const SHOWN = 20;

/** What a row needs of an event. */
const FeedSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      createdAt: z.number(),
      requestId: z.string().optional(),
      simulated: z.literal(true).optional(),
    }),
  ),
});

/**
 * The pass's events newest first, what a webhook would have been sent, each with the request that
 * caused it. Under it, admin's sync log: why a device did or did not update.
 */
export function PassEventsTab({ pass, orgId }: { pass: PassDetailDto; orgId: string }) {
  const api = useToolApi();
  const key = useToolKey();
  const feed = useQuery({
    queryKey: ['workbench', 'passes', 'events', pass.id, ...key],
    queryFn: ({ signal }) =>
      api.get('/api/v1/events', FeedSchema, {
        query: { orgId, passId: pass.id, order: 'desc', limit: SHOWN },
        signal,
      }),
    refetchInterval: pollEvery(TAB_POLL_MS),
    refetchIntervalInBackground: false,
  });
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <section aria-label={WB_PASSES.events.title} className="flex min-w-0 flex-col gap-2">
        <h3 className="text-sm font-semibold text-fg-strong">{WB_PASSES.events.title}</h3>
        {feed.isPending ? (
          <Skeleton className="h-20 w-full" />
        ) : feed.isError ? (
          <ToolFailed error={feed.error} onRetry={() => void feed.refetch()} />
        ) : feed.data.items.length === 0 ? (
          <p className="text-sm text-fg-muted">{WB_PASSES.events.empty}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {feed.data.items.map((e) => (
              <li key={e.id} className="flex min-h-11 min-w-0 flex-wrap items-center gap-x-3 py-2">
                <WbLink
                  href={wbEventsPath(orgId, { event: e.id })}
                  className="min-w-0 font-mono text-sm text-fg-strong hover:underline"
                >
                  {e.type}
                </WbLink>
                {e.simulated ? (
                  <span className="rounded-sm border border-border px-1.5 text-xs text-fg-muted">
                    {WB_PASSES.events.simulated}
                  </span>
                ) : null}
                {e.requestId ? (
                  <WbLink
                    href={wbPath(orgId, 'logs', { hash: e.requestId })}
                    className="inline-flex items-center gap-1 font-mono text-xs text-accent-fg hover:underline"
                  >
                    {WB_PASSES.events.request}
                    <ArrowUpRight className="size-3" aria-hidden />
                  </WbLink>
                ) : null}
                <BenchTime at={e.createdAt} className="ml-auto font-mono text-xs text-fg-muted" />
              </li>
            ))}
          </ul>
        )}
        <WbLink
          href={wbEventsPath(orgId, { pass: pass.id })}
          className="inline-flex items-center gap-1 self-start text-sm text-accent-fg hover:underline"
        >
          {WB_PASSES.events.all}
          <ArrowUpRight className="size-3.5" aria-hidden />
        </WbLink>
      </section>
      <div className="flex min-w-0 flex-col gap-2">
        <h3 className="text-sm font-semibold text-fg-strong">{WB_PASSES.events.sync}</h3>
        <SyncTab pass={pass} active flat messageLinks={false} />
      </div>
    </div>
  );
}
