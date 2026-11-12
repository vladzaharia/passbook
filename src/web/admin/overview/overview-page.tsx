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
import { GetStarted, setupDone, useGetStartedDismissed } from './get-started.tsx';
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
    // While the checklist shows, every visit refetches so a step ticks as soon as it is done.
    staleTime: (q) => (q.state.data && !setupDone(q.state.data.setup) ? 0 : 30_000),
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
function GovernanceSummary({
  organizations,
  loading,
  filtered,
}: {
  organizations: number | undefined;
  loading: boolean;
  filtered: boolean;
}) {
  return (
    <section aria-label="Platform directories" className="grid gap-3 md:grid-cols-3">
      <Card>
        <CardBody className="flex h-full flex-col items-start gap-2">
          <h2 className="text-sm font-semibold text-fg-strong">
            Organizations · {filtered ? 'filtered · ' : ''}all modes
          </h2>
          <p className="text-2xl font-semibold text-fg-strong tabular-nums">
            {organizations === undefined ? (
              <span className="text-sm font-normal text-fg-muted">
                {loading ? 'Loading count…' : 'Count unavailable'}
              </span>
            ) : (
              formatCount(organizations)
            )}
          </p>
          <p className="text-sm text-fg-muted">
            {filtered
              ? 'Non-deleted organizations matching the platform filter.'
              : 'Non-deleted organizations across the platform.'}
          </p>
          <Button asChild variant="link" className="mt-auto">
            <Link to="/admin/orgs">View organizations</Link>
          </Button>
        </CardBody>
      </Card>
      <Card>
        <CardBody className="flex h-full flex-col items-start gap-2">
          <h2 className="text-sm font-semibold text-fg-strong">Platform accounts</h2>
          <p className="text-sm text-fg-muted">Browse the global account directory.</p>
          <Button asChild variant="link" className="mt-auto">
            <Link to="/admin/users">View accounts</Link>
          </Button>
        </CardBody>
      </Card>
      <Card>
        <CardBody className="flex h-full flex-col items-start gap-2">
          <h2 className="text-sm font-semibold text-fg-strong">Apple identities</h2>
          <p className="text-sm text-fg-muted">Review signing identities and their certificates.</p>
          <Button asChild variant="link" className="mt-auto">
            <Link to="/admin/identities">View identities</Link>
          </Button>
        </CardBody>
      </Card>
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
  const [dismissed, dismiss] = useGetStartedDismissed();
  const data = metrics.data;
  const shownRange = metrics.isPlaceholderData ? (data?.range ?? range) : range;
  const checklist = data !== undefined && !dismissed && !setupDone(data.setup);
  // Do not hide existing Test-mode metrics merely because platform setup tracks Live passes.
  const firstRun = checklist && data.setup.passes === 0 && data.totals.passes === 0;
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
      <PageHeader
        title="Overview"
        breadcrumbs={[{ label: 'Platform', to: '/admin' }, { label: 'Overview' }]}
        meta={`Metrics: ${organizationName ?? 'All organizations'} · ${mode === 'test' ? 'Test' : 'Live'} mode`}
        actions={firstRun ? undefined : picker}
      />
      <div className="flex flex-col gap-6">
        <div className="flex max-w-md flex-col gap-2">
          <Label htmlFor={filterId}>Platform organization filter</Label>
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
              Clear organization filter
            </Button>
          ) : null}
        </div>
        <Health />
        <GovernanceSummary
          organizations={data?.setup.orgs}
          loading={metrics.isPending}
          filtered={Boolean(orgId)}
        />
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
            {firstRun ? null : (
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
            )}
            {checklist ? (
              <GetStarted setup={data.setup} organization={organizationName} onDismiss={dismiss} />
            ) : null}
            {/* With no passes yet the checklist stands in for the (empty) charts. */}
            {firstRun ? null : (
              <ChartsCard data={data} range={shownRange} enter={arrived} busy={busy} />
            )}
          </>
        )}
        <RecentActivity orgId={orgId} />
      </div>
    </>
  );
}
