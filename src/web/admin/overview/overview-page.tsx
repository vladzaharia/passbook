import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { MetricsOverviewSchema } from '@/shared/contracts/metrics.ts';
import { api } from '@/web/lib/api.ts';
import { useOrgFilter } from '@/web/lib/org-filter.tsx';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  ErrorState,
  PageHeader,
  Select,
  Skeleton,
  SkeletonRows,
  StatusPill,
  Timeline,
} from '@/web/ui/index.ts';
import { useAuditLog } from '../audit/queries.ts';
import { sortBySeverity, useStatus } from '../status/queries.ts';
import { LineChart } from './chart.tsx';
import { formatCount } from './format.ts';

export type Range = '24h' | '7d' | '30d';
export interface OverviewSearch {
  range?: Range | undefined;
}

export function parseOverviewSearch(raw: Record<string, unknown>): OverviewSearch {
  return {
    range: raw.range === '24h' || raw.range === '30d' || raw.range === '7d' ? raw.range : undefined,
  };
}

function useMetrics(range: Range, orgId: string | undefined) {
  return useQuery({
    queryKey: ['metrics', range, orgId ?? null],
    queryFn: ({ signal }) =>
      api.get('/api/v1/metrics/overview', MetricsOverviewSchema, {
        query: { range, orgId },
        signal,
      }),
    staleTime: 30_000,
  });
}

function Kpi({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <li className="rounded-lg border border-border bg-surface-raised p-4">
      <p className="text-xs text-fg-muted">{label}</p>
      <p
        className={`mt-1 text-2xl font-semibold ${warn && value > 0 ? 'text-danger' : 'text-fg-strong'}`}
      >
        {formatCount(value)}
      </p>
    </li>
  );
}

function Health() {
  const status = useStatus();
  return (
    <Card>
      <CardHeader
        title="Health"
        actions={
          <Link to="/admin/status" className="text-xs text-accent-fg underline">
            All components
          </Link>
        }
      />
      <CardBody>
        {status.isPending ? (
          <SkeletonRows rows={2} label="Loading health" />
        ) : status.isError ? (
          <ErrorState error={status.error} onRetry={() => status.refetch()} />
        ) : (
          <div className="flex flex-col gap-3">
            <StatusPill status={status.data.overall} />
            {(() => {
              const problems = sortBySeverity(status.data.components).filter(
                (c) => c.state === 'failing' || c.state === 'degraded',
              );
              return problems.length === 0 ? (
                <p className="text-sm text-fg-muted">No failing or degraded components.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {problems.slice(0, 5).map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="min-w-0 truncate">{c.label}</span>
                      <StatusPill status={c.state} />
                    </li>
                  ))}
                </ul>
              );
            })()}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function Activity({ orgId }: { orgId: string | undefined }) {
  const log = useAuditLog({ orgId }, 8);
  const items = log.data?.pages[0]?.items ?? [];
  return (
    <Card>
      <CardHeader
        title="Recent activity"
        actions={
          <Link to="/admin/audit" className="text-xs text-accent-fg underline">
            Audit log
          </Link>
        }
      />
      <CardBody>
        {log.isPending ? (
          <SkeletonRows rows={3} label="Loading activity" />
        ) : log.isError ? (
          <ErrorState error={log.error} onRetry={() => log.refetch()} />
        ) : items.length === 0 ? (
          <p className="text-sm text-fg-muted">No activity yet.</p>
        ) : (
          <Timeline
            items={items.map((e) => ({
              id: String(e.id),
              title: <code className="font-mono text-xs">{e.action}</code>,
              time: e.at,
              description: e.targetType ? `${e.targetType} ${e.targetId ?? ''}` : undefined,
            }))}
          />
        )}
      </CardBody>
    </Card>
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
  const { orgId } = useOrgFilter();
  const metrics = useMetrics(range, orgId);
  const picker = (
    <Select
      aria-label="Range"
      className="w-36"
      value={range}
      onValueChange={(v) => onSearch({ range: v as Range })}
      options={[
        { value: '24h', label: 'Last 24 hours' },
        { value: '7d', label: 'Last 7 days' },
        { value: '30d', label: 'Last 30 days' },
      ]}
    />
  );
  return (
    <>
      <PageHeader title="Overview" actions={picker} />
      <div className="flex flex-col gap-6">
        {metrics.isPending ? (
          <div role="status" aria-busy className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <span className="sr-only">Loading metrics</span>
            {Array.from({ length: 8 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
              <Skeleton key={i} className="h-20" />
            ))}
          </div>
        ) : metrics.isError ? (
          <ErrorState error={metrics.error} onRetry={() => metrics.refetch()} />
        ) : (
          <>
            <ul aria-label="Totals" className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Kpi label="Passes" value={metrics.data.totals.passes} />
              <Kpi label="Active" value={metrics.data.totals.activePasses} />
              <Kpi label="Voided" value={metrics.data.totals.voidedPasses} />
              <Kpi label="Holders" value={metrics.data.totals.holders} />
              <Kpi label="Devices" value={metrics.data.totals.devices} />
              <Kpi label={`Issued, ${range}`} value={metrics.data.totals.issued} />
              <Kpi label={`Downloads, ${range}`} value={metrics.data.totals.downloads} />
              <Kpi
                label={`Push failures, ${range}`}
                value={metrics.data.totals.pushFailures}
                warn
              />
            </ul>
            <Card>
              <CardHeader
                title="Activity"
                actions={
                  metrics.data.source === 'd1' ? (
                    <Badge title="Counted from the database">Approximate</Badge>
                  ) : null
                }
              />
              <CardBody className="grid gap-6 md:grid-cols-2">
                <LineChart title="Issued" points={metrics.data.series.issued} range={range} />
                <LineChart title="Updated" points={metrics.data.series.updated} range={range} />
                <LineChart title="Downloads" points={metrics.data.series.downloads} range={range} />
                <LineChart title="Pushes" points={metrics.data.series.pushes} range={range} />
              </CardBody>
            </Card>
          </>
        )}
        <div className="grid gap-6 lg:grid-cols-2">
          <Health />
          <Activity orgId={orgId} />
        </div>
      </div>
    </>
  );
}
