import { Link } from '@tanstack/react-router';
import { Plus, Table2 } from 'lucide-react';
import { useState } from 'react';
import type { OrgActivity } from '@/shared/contracts/metrics.ts';
import { canSeeOrgOverview } from '@/web/lib/guards.ts';
import { useMode } from '@/web/lib/mode.ts';
import { useArrival } from '@/web/lib/motion.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import { useSession } from '@/web/lib/session.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  LoadingRail,
  PageHeader,
  Select,
  Skeleton,
  useDelayed,
} from '@/web/ui/index.ts';
import { LineChart } from './chart.tsx';
import { FirstPassCard, NextRow, useNextRowDismissed } from './first-pass.tsx';
import { currentStep } from './first-pass-state.ts';
import { RANGE_LABEL } from './kpis.tsx';
import { OrgCounts } from './org-overview-counts.tsx';
import { useOrgActivity, useOrgSetup } from './org-overview-queries.ts';
import { TemplateBreakdown } from './org-overview-templates.tsx';
import { NotAddedCard, OrgTiles } from './org-overview-tiles.tsx';
import './org-overview.css';
import type { OverviewSearch } from './overview-search.ts';
import { PlanNotice } from './plan-notice.tsx';
import type { Range } from './range.ts';
import { OrgRecentActivity } from './recent-activity.tsx';
import { SandboxCard } from './sandbox-card.tsx';

function OrgSkeleton() {
  return (
    <div role="status" aria-busy className="flex flex-col gap-6">
      <span className="sr-only">Loading metrics</span>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {['a', 'b', 'c', 'd', 'e'].map((k) => (
          <Skeleton key={k} className="h-[6.5rem]" />
        ))}
      </div>
      <Skeleton className="h-24" />
      <Skeleton className="h-64" />
    </div>
  );
}

/** Issued and scans over the range; one toggle swaps both plots for their numbers. */
function OrgCharts({
  data,
  range,
  enter,
  busy,
}: {
  data: OrgActivity;
  range: Range;
  enter: boolean;
  busy: boolean;
}) {
  const [showData, setShowData] = useState(false);
  return (
    <Card aria-busy={busy || undefined}>
      <LoadingRail show={busy} />
      <CardHeader
        title="Activity"
        actions={
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={showData}
            iconStart={<Table2 aria-hidden />}
            className="aria-pressed:bg-accent-subtle aria-pressed:text-fg-strong"
            onClick={() => setShowData((v) => !v)}
          >
            Show data
          </Button>
        }
      />
      <CardBody className="grid gap-x-8 gap-y-4 md:grid-cols-2">
        <LineChart
          title="Issued"
          points={data.series.issued}
          range={range}
          enter={enter}
          showData={showData}
        />
        <LineChart
          title="Scans"
          points={data.series.scans}
          range={range}
          enter={enter}
          showData={showData}
        />
      </CardBody>
    </Card>
  );
}

/**
 * The member's Overview: this organization's passes by template over 24 hours, 7 or 30 days. With
 * no passes yet it is the first-pass path; once the path is done, a Next row.
 */
export function OrgOverviewPage({
  search,
  onSearch,
}: {
  search: OverviewSearch;
  onSearch: (next: OverviewSearch) => void;
}) {
  const range = search.range ?? '7d';
  const { membership } = useOrgScope();
  const principal = useSession().authed?.user.id;
  const mode = useMode();
  // The route gate decides; this keeps a page that is mid-navigation from asking anyway.
  const orgId = canSeeOrgOverview(membership) ? membership?.orgId : undefined;
  const caps = membership?.capabilities ?? [];
  const activity = useOrgActivity(orgId, principal, range);
  const data = activity.data;
  const arrived = useArrival(activity.isPending);
  const busy = useDelayed(activity.isPlaceholderData && activity.isFetching, 150);
  const empty = data !== undefined && data.templates.length === 0;
  const sandbox = membership?.testOnly === true;
  const [dismissed, dismiss] = useNextRowDismissed(orgId);
  const setup = useOrgSetup(orgId, principal, !dismissed && !sandbox);
  const shownRange = activity.isPlaceholderData ? (data?.range ?? range) : range;
  const countScope = JSON.stringify(['org', principal ?? null, orgId ?? null, mode]);
  const canOperate = caps.includes('passes:operate');
  // A sandbox is set up by the quickstart and never holds a wallet pass: nothing to walk through.
  const step = setup.data && !sandbox ? currentStep(setup.data.setup) : undefined;
  const path =
    orgId && caps.includes('templates:author') && setup.data && step ? (
      <FirstPassCard orgId={orgId} setup={setup.data.setup} />
    ) : null;
  const next =
    orgId && canOperate && setup.data && step === null && !dismissed ? (
      <NextRow orgId={orgId} setup={setup.data.setup} onDismiss={dismiss} />
    ) : null;
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
        breadcrumbs={[{ label: membership?.orgName ?? 'Organization' }, { label: 'Overview' }]}
        actions={empty ? undefined : picker}
      />
      <div className="flex flex-col gap-6">
        {sandbox ? <SandboxCard /> : null}
        {orgId && !path && !(empty && setup.isPending && !dismissed && !sandbox) ? (
          <OrgCounts orgId={orgId} caps={caps} sandbox={sandbox} />
        ) : null}
        {orgId && caps.includes('org:read') && !sandbox ? <PlanNotice orgId={orgId} /> : null}
        {activity.isPending ? (
          <OrgSkeleton />
        ) : activity.isError || !data ? (
          <ErrorState error={activity.error} onRetry={() => activity.refetch()} />
        ) : empty ? (
          // The path is the page's empty state while it is up; the box returns once it is gone.
          (path ??
          next ??
          (setup.isPending && !dismissed && !sandbox ? (
            <Skeleton className="h-64" />
          ) : (
            <EmptyState
              art="passes"
              title="No passes yet"
              action={
                canOperate ? (
                  <Button asChild variant="primary" iconStart={<Plus aria-hidden />}>
                    <Link to="/admin/passes/new">New pass</Link>
                  </Button>
                ) : undefined
              }
            />
          )))
        ) : (
          <>
            {path ?? next}
            {activity.isPlaceholderData ? (
              <p role="status" className="text-sm text-fg-muted">
                Updating metrics. Showing {RANGE_LABEL[shownRange].toLowerCase()} until they arrive.
              </p>
            ) : null}
            <OrgTiles
              key={countScope}
              data={data}
              range={shownRange}
              enter={arrived}
              countScope={countScope}
              canScan={caps.includes('scanning:read')}
            />
            <NotAddedCard
              count={data.totals.notAdded}
              countScope={countScope}
              canOperate={canOperate}
            />
            <TemplateBreakdown data={data} range={shownRange} canOpen />
            <OrgCharts data={data} range={shownRange} enter={arrived} busy={busy} />
          </>
        )}
        {orgId && caps.includes('audit:read') ? (
          <OrgRecentActivity orgId={orgId} orgName={membership?.orgName ?? ''} hideEmpty={empty} />
        ) : null}
      </div>
    </>
  );
}
