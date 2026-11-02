import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { MetricsOverviewSchema } from '@/shared/contracts/metrics.ts';
import { api } from '@/web/lib/api.ts';
import { useArrival } from '@/web/lib/motion.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import {
  Card,
  CardBody,
  ErrorState,
  PageHeader,
  Select,
  Skeleton,
  useDelayed,
} from '@/web/ui/index.ts';
import { ChartsCard } from './charts-card.tsx';
import { GetStarted, setupDone, useGetStartedDismissed } from './get-started.tsx';
import { Health } from './health.tsx';
import { Kpis, RANGE_LABEL } from './kpis.tsx';
import type { OverviewSearch } from './overview-search.ts';
import type { Range } from './range.ts';
import { RecentActivity } from './recent-activity.tsx';

export type { OverviewSearch, Range };

/** A range or scope change keeps the old numbers on screen until the new ones land. */
function useMetrics(range: Range, orgId: string | undefined) {
  return useQuery({
    queryKey: ['metrics', range, orgId ?? null],
    queryFn: ({ signal }) =>
      api.get('/api/v1/metrics/overview', MetricsOverviewSchema, {
        query: { range, orgId },
        signal,
      }),
    // While the checklist shows, every visit refetches so a step ticks as soon as it is done.
    staleTime: (q) => (q.state.data && !setupDone(q.state.data.setup) ? 0 : 30_000),
    placeholderData: keepPreviousData,
  });
}

/** The loaded layout's shape: four tiles, the counts row, the charts card. */
function MetricsSkeleton() {
  return (
    <div role="status" aria-busy className="flex flex-col gap-6">
      <span className="sr-only">Loading metrics</span>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {['a', 'b', 'c', 'd'].map((k) => (
            <Skeleton key={k} className="h-[6.5rem]" />
          ))}
        </div>
        <Skeleton className="h-6 w-80 max-w-full" />
      </div>
      <Card>
        <div className="h-14 border-b border-border" />
        <CardBody className="grid gap-x-8 gap-y-4 md:grid-cols-2">
          {['a', 'b', 'c', 'd'].map((k) => (
            <Skeleton key={k} className="h-[8.25rem]" />
          ))}
        </CardBody>
      </Card>
    </div>
  );
}

export function OverviewPage({
  search,
  onSearch,
}: {
  search: OverviewSearch;
  onSearch: (next: OverviewSearch) => void;
}) {
  const range = search.range ?? '7d';
  const { orgId } = useOrgScope();
  const metrics = useMetrics(range, orgId);
  const arrived = useArrival(metrics.isPending);
  const busy = useDelayed(metrics.isPlaceholderData && metrics.isFetching, 150);
  const [dismissed, dismiss] = useGetStartedDismissed();
  const data = metrics.data;
  const checklist = data !== undefined && !dismissed && !setupDone(data.setup);
  // Before the first pass every count is zero: the checklist leads and the numbers wait.
  const firstRun = checklist && data.setup.passes === 0;
  const picker = (
    <Select
      aria-label="Range"
      className="w-40"
      value={range}
      onValueChange={(v) => onSearch({ range: v as Range })}
      options={(['24h', '7d', '30d'] as const).map((r) => ({ value: r, label: RANGE_LABEL[r] }))}
    />
  );
  return (
    <>
      <PageHeader title="Overview" actions={firstRun ? undefined : picker} />
      <div className="flex flex-col gap-6">
        {metrics.isPending ? (
          <MetricsSkeleton />
        ) : metrics.isError || !data ? (
          <ErrorState error={metrics.error} onRetry={() => metrics.refetch()} />
        ) : (
          <>
            {firstRun ? null : <Kpis data={data} range={range} enter={arrived} />}
            {checklist ? <GetStarted setup={data.setup} onDismiss={dismiss} /> : null}
            {/* With no passes yet the checklist stands in for the (empty) charts. */}
            {firstRun ? null : <ChartsCard data={data} range={range} enter={arrived} busy={busy} />}
          </>
        )}
        <div className="grid gap-6 xl:grid-cols-3">
          <Health />
          <div className="min-w-0 xl:col-span-2">
            <RecentActivity orgId={orgId} />
          </div>
        </div>
      </div>
    </>
  );
}
