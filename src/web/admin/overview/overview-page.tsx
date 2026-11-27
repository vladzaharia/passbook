import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId } from 'react';
import { MetricsOverviewSchema } from '@/shared/contracts/metrics.ts';
import { api } from '@/web/lib/api.ts';
import { formatCount } from '@/web/lib/format.ts';
import { useMode } from '@/web/lib/mode.ts';
import { useArrival } from '@/web/lib/motion.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import { useSession } from '@/web/lib/session.ts';
import {
  Button,
  Card,
  CardBody,
  Combobox,
  ErrorState,
  Label,
  PageHeader,
  Select,
  Skeleton,
  useDelayed,
} from '@/web/ui/index.ts';
import { useOrgPages } from '../orgs/org-pages.ts';
import { useOrgNames } from '../orgs/queries.ts';
import { ChartsCard } from './charts-card.tsx';
import { DeveloperFunnelTile } from './developer-funnel.tsx';
import { Health } from './health.tsx';
import { Kpis, RANGE_LABEL } from './kpis.tsx';
import type { OverviewSearch } from './overview-search.ts';
import type { Range } from './range.ts';
import { RecentActivity } from './recent-activity.tsx';

export type { OverviewSearch, Range };

/** A range change keeps the old numbers on screen until the new ones land. */
function useMetrics(range: Range, orgId: string | undefined, principal: string | undefined) {
  return useQuery({
    queryKey: ['metrics', 'platform', principal ?? null, orgId ?? null, range],
    enabled: principal !== undefined,
    queryFn: ({ signal }) =>
      api.get('/api/v1/metrics/platform/overview', MetricsOverviewSchema, {
        query: { range, orgId },
        signal,
      }),
    staleTime: 30_000,
    placeholderData: (previous, query) =>
      principal !== undefined &&
      query?.queryKey[2] === principal &&
      query.queryKey[3] === (orgId ?? null)
        ? previous
        : undefined,
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

/** Directory links remain available even when overview metrics fail to load. */
function CountText({ count, loading }: { count: number | undefined; loading: boolean }) {
  return (
    <p className="text-2xl font-semibold text-fg-strong tabular-nums">
      {count === undefined ? (
        <span className="text-sm font-normal text-fg-muted">
          {loading ? 'Loading count…' : 'Count unavailable'}
        </span>
      ) : (
        formatCount(count)
      )}
    </p>
  );
}

function GovernanceSummary({
  counts,
  loading,
  filtered,
}: {
  counts: { organizations?: number; users?: number; walletAccounts?: number };
  loading: boolean;
  filtered: boolean;
}) {
  const cards = [
    {
      title: `Organizations${filtered ? ' · filtered' : ''}`,
      count: counts.organizations,
      to: '/admin/platform/orgs',
      link: 'View organizations',
    },
    {
      title: `Users${filtered ? ' · filtered' : ''}`,
      count: counts.users,
      to: '/admin/platform/users',
      link: 'View users',
    },
    {
      title: `Wallet accounts${filtered ? ' · filtered' : ''}`,
      count: counts.walletAccounts,
      to: '/admin/platform/wallet-accounts',
      link: 'View wallet accounts',
    },
  ];
  return (
    <section aria-label="Platform directories" className="grid gap-3 md:grid-cols-3">
      {cards.map((card) => (
        <Card key={card.to}>
          <CardBody className="flex h-full flex-col items-start gap-2">
            <h2 className="text-sm font-semibold text-fg-strong">{card.title}</h2>
            <CountText count={card.count} loading={loading} />
            <Button asChild variant="link" className="mt-auto">
              <Link to={card.to}>{card.link}</Link>
            </Button>
          </CardBody>
        </Card>
      ))}
    </section>
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
  const orgId = search.filterOrgId;
  const { memberships } = useOrgScope();
  const filterId = useId();
  const directory = useOrgPages();
  const fallbackName = useOrgNames();
  const orgItems = directory.data?.pages.flatMap((page) => page.items) ?? [];
  const organizationName = orgId
    ? (orgItems.find((org) => org.id === orgId)?.name ?? fallbackName(orgId))
    : undefined;
  const orgOptions = [
    { value: '', label: 'All organizations' },
    ...(orgId && !orgItems.some((org) => org.id === orgId)
      ? [{ value: orgId, label: organizationName ?? orgId }]
      : []),
    ...orgItems.map((org) => ({ value: org.id, label: org.name })),
  ];
  const session = useSession();
  const principal = session.isAdmin && !session.isError ? session.authed?.user.id : undefined;
  const mode = useMode();
  const countScope = JSON.stringify(['platform', principal ?? null, orgId ?? null, mode]);
  const metrics = useMetrics(range, orgId, principal);
  const arrived = useArrival(metrics.isPending);
  const busy = useDelayed(metrics.isPlaceholderData && metrics.isFetching, 150);
  const data = metrics.data;
  const shownRange = metrics.isPlaceholderData ? (data?.range ?? range) : range;
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
        <div className="flex max-w-md flex-col gap-2">
          <Label htmlFor={filterId}>Organization</Label>
          <Combobox
            id={filterId}
            options={orgOptions}
            value={orgId ?? ''}
            onValueChange={(value) => onSearch({ filterOrgId: value || undefined })}
            searchPlaceholder="Search loaded organizations"
            loading={directory.isPending}
          />
          {directory.isError ? (
            <div className="text-sm text-danger">
              Organizations could not be loaded.{' '}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  void (directory.isFetchNextPageError
                    ? directory.fetchNextPage()
                    : directory.refetch())
                }
              >
                Retry organizations
              </Button>
            </div>
          ) : directory.hasNextPage ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="self-start"
              loading={directory.isFetchingNextPage}
              onClick={() => void directory.fetchNextPage()}
            >
              Load more organizations
            </Button>
          ) : null}
          {orgId ? (
            <Button
              variant="ghost"
              size="sm"
              className="self-start"
              onClick={() => onSearch({ filterOrgId: undefined })}
            >
              Clear filter
            </Button>
          ) : null}
        </div>
        <Health />
        <GovernanceSummary
          counts={{
            organizations: data?.setup.orgs,
            users: data?.directory?.users,
            walletAccounts: data?.directory?.walletAccounts,
          }}
          loading={metrics.isPending}
          filtered={Boolean(orgId)}
        />
        <DeveloperFunnelTile />
        {metrics.isPending ? (
          <MetricsSkeleton />
        ) : metrics.isError || !data ? (
          <ErrorState error={metrics.error} onRetry={() => metrics.refetch()} />
        ) : (
          <>
            {metrics.isPlaceholderData ? (
              <p role="status" className="text-sm text-fg-muted">
                Updating metrics. Showing {RANGE_LABEL[shownRange].toLowerCase()} until they arrive.
              </p>
            ) : null}
            <Kpis
              key={countScope}
              countScope={countScope}
              data={data}
              range={shownRange}
              enter={arrived}
              listOrgId={
                orgId ? (memberships.some((m) => m.orgId === orgId) ? orgId : null) : undefined
              }
            />
            <ChartsCard data={data} range={shownRange} enter={arrived} busy={busy} />
          </>
        )}
        <RecentActivity orgId={orgId} />
      </div>
    </>
  );
}
