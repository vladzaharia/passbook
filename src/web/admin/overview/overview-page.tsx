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
import type { Range } from './chart.tsx';
import { ChartsCard } from './charts-card.tsx';
import { GetStarted, setupDone, useGetStartedDismissed } from './get-started.tsx';
import { Health } from './health.tsx';
import { Kpis, RANGE_LABEL } from './kpis.tsx';
import { RecentActivity } from './recent-activity.tsx';

export type { Range };
export interface OverviewSearch {
  range?: Range | undefined;
}

export function parseOverviewSearch(raw: Record<string, unknown>): OverviewSearch {
  return {
    range: raw.range === '24h' || raw.range === '30d' || raw.range === '7d' ? raw.range : undefined,
  };
}

/** A range or scope change keeps the old numbers on screen until the new ones land. */
function useMetrics(range: Range, orgId: string | undefined) {
  return useQuery({
    queryKey: ['metrics', range, orgId ?? null],
    queryFn: ({ signal }) =>
      api.get('/api/v1/metrics/overview', MetricsOverviewSchema, {
        query: { range, orgId },
        signal,
      }),
    staleTime: 30_000,
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
      <PageHeader title="Overview" actions={picker} />
      <div className="flex flex-col gap-6">
        {metrics.isPending ? (
          <MetricsSkeleton />
        ) : metrics.isError || !data ? (
          <ErrorState error={metrics.error} onRetry={() => metrics.refetch()} />
        ) : (
          <>
            <Kpis data={data} range={range} enter={arrived} />
            {!dismissed && !setupDone(data.setup) ? (
              <GetStarted setup={data.setup} onDismiss={dismiss} />
            ) : (
              <ChartsCard data={data} range={range} enter={arrived} busy={busy} />
            )}
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
