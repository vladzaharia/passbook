import { RefreshCw } from 'lucide-react';
import { cn } from '@/web/lib/cn.ts';
import { statusOf } from '@/web/lib/status.ts';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  SkeletonRows,
  StatusPill,
} from '@/web/ui/index.ts';
import { useOrgNames } from '../orgs/queries.ts';
import { formatDateTime } from '../overview/format.ts';
import { ComponentRow } from './component-row.tsx';
import { dataItems } from './data-items.ts';
import { countStates, groupComponents, headline, type State } from './groups.ts';
import { sortBySeverity, useStatus } from './queries.ts';
import { WorkflowRuns } from './workflow-runs.tsx';

const ORDER: State[] = ['failing', 'degraded', 'not_configured', 'configured', 'verified'];

const TONE_BG: Record<string, string> = {
  success: 'border-success-border bg-success-subtle',
  info: 'border-info-border bg-info-subtle',
  warning: 'border-warning-border bg-warning-subtle',
  danger: 'border-danger-border bg-danger-subtle',
  neutral: 'border-border bg-surface-raised',
};

function Summary({
  overall,
  counts,
  checkedAt,
  fetching,
  onRecheck,
}: {
  overall: State;
  counts: Record<State, number>;
  checkedAt: number;
  fetching: boolean;
  onRecheck: () => void;
}) {
  const entry = statusOf(overall);
  const Icon = entry?.icon;
  return (
    <section
      aria-label="Overall status"
      className={cn(
        'flex flex-wrap items-center gap-x-5 gap-y-4 rounded-lg border p-5',
        TONE_BG[entry?.tone ?? 'neutral'],
      )}
    >
      {Icon ? <Icon aria-hidden className="size-9 shrink-0 text-fg-strong" /> : null}
      <div className="min-w-0 flex-1 basis-60">
        <p className="text-xl font-semibold text-fg-strong">{headline(counts)}</p>
        <p className="mt-0.5 text-sm text-fg">
          Checked{' '}
          <time dateTime={new Date(checkedAt).toISOString()}>{formatDateTime(checkedAt)}</time>
        </p>
      </div>
      <Button
        variant="outline"
        iconStart={<RefreshCw aria-hidden />}
        loading={fetching}
        onClick={onRecheck}
      >
        Recheck
      </Button>
      <ul aria-label="Component counts" className="flex basis-full flex-wrap gap-2">
        {ORDER.filter((s) => counts[s] > 0).map((s) => (
          <li key={s}>
            <StatusPill status={s}>
              {counts[s]} {statusOf(s)?.label.toLowerCase()}
            </StatusPill>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function StatusPage() {
  const status = useStatus();
  const orgName = useOrgNames();
  const data = status.data;
  return (
    <>
      <PageHeader title="Status" width="detail" />
      {status.isPending ? (
        <SkeletonRows label="Loading status" />
      ) : status.isError || !data ? (
        <ErrorState error={status.error} onRetry={() => status.refetch()} />
      ) : (
        <div className="flex max-w-3xl flex-col gap-8">
          <Summary
            overall={data.overall}
            counts={countStates(data.components)}
            checkedAt={Math.max(0, ...data.components.map((c) => c.checkedAt))}
            fetching={status.isFetching}
            onRecheck={() => status.refetch()}
          />
          {data.components.length === 0 ? (
            <EmptyState title="No components reported" />
          ) : (
            groupComponents(data.components).map((g) => {
              const worst = countStates(g.items);
              const problems = worst.failing + worst.degraded;
              return (
                <section key={g.id} aria-labelledby={`g-${g.id}`} className="flex flex-col gap-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <h2 id={`g-${g.id}`} className="text-base font-semibold text-fg-strong">
                      {g.title}
                    </h2>
                    {problems > 0 ? (
                      <span className="text-sm text-fg-muted">{problems} need attention</span>
                    ) : null}
                  </div>
                  <Card className="overflow-hidden">
                    <ul aria-label={g.title} className="divide-y divide-border">
                      {sortBySeverity(g.items).map((c) => (
                        <ComponentRow
                          key={c.id}
                          component={c}
                          items={c.data ? dataItems(c.data, orgName) : []}
                        />
                      ))}
                    </ul>
                  </Card>
                </section>
              );
            })
          )}
          <WorkflowRuns />
        </div>
      )}
    </>
  );
}
