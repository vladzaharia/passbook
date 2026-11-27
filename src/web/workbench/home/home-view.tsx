import { Link, useRouter } from '@tanstack/react-router';
import { ArrowUpRight, KeyRound, RefreshCw, SquareTerminal } from 'lucide-react';
import { lazy, type ReactNode, Suspense, useCallback, useMemo } from 'react';
import { WB_HOME_COPY as C } from '../../../shared/copy/workbench-home.ts';
import { WB_SHELL_COPY } from '../../../shared/copy/workbench-shell.ts';
import { WB_STATES } from '../../../shared/copy/workbench-states.ts';
import { wbPath } from '../../../shared/workbench.ts';
import { Button } from '../../ui/button.tsx';
import { DropdownMenuItem } from '../../ui/dropdown-menu.tsx';
import { MoreMenu } from '../../ui/more-menu.tsx';
import { useNow } from '../../ui/rel-time.tsx';
import { Skeleton } from '../../ui/skeleton.tsx';
import { StatusChip } from '../bench/status-chip.tsx';
import { adminLink, useToolHost } from '../host/tool-host.tsx';
import { ToolPage } from '../shell/tool-page.tsx';
import { StageState } from '../states/states.tsx';
import {
  useFresh,
  useHomeSummary,
  usePassLink,
  useRecentCalls,
  useRecentEvents,
  useRecentPasses,
} from './data.ts';
import { RecentCalls, RecentEventsPanel } from './lists.tsx';
import { type Milestone, useMilestone } from './milestones.ts';
import { NextStep } from './next-step.tsx';
import { PassesFan, PhoneCard } from './passes.tsx';
import { Stats } from './stats.tsx';

// Its own chunk: the sparks and the toast load only when a milestone fires.
const Moment = lazy(() => import('./moment.tsx'));

const SEAT: Record<Milestone, { text: string; tool: 'logs' | 'passes' | 'events' }> = {
  firstCall: { text: C.celebrate.firstCall, tool: 'logs' },
  onPhone: { text: C.celebrate.onPhone, tool: 'passes' },
  quickstart: { text: C.celebrate.quickstart, tool: 'passes' },
  webhook: { text: C.celebrate.webhook, tool: 'events' },
};

/** Home in one context: the live surface of Test (design §1.7). Every read rides the token client. */
export function HomeView() {
  const { api, context } = useToolHost();
  const { orgId } = context;
  const router = useRouter();
  const now = useNow(30_000);
  const summary = useHomeSummary(api);
  const calls = useRecentCalls(api);
  const passes = useRecentPasses(api);
  const events = useRecentEvents(api);
  const link = usePassLink(api, passes.data?.items[0]?.id);

  const callIds = useMemo(() => calls.data?.items.map((c) => c.id), [calls.data]);
  const eventIds = useMemo(() => events.items.map((e) => e.id), [events.items]);
  const freshCalls = useFresh(callIds, calls.data !== undefined);
  const freshEvents = useFresh(eventIds, !events.loading);

  const signals = {
    firstCall: calls.data?.items.some((c) => c.status >= 200 && c.status < 300) ?? false,
    onPhone: passes.data?.items.some((p) => p.deviceCount > 0) ?? false,
    quickstart: summary.data?.quickstart
      ? summary.data.quickstart.done >= summary.data.quickstart.total
      : false,
    webhook: events.items.length > 0,
  };
  const moment = useMilestone(
    orgId,
    signals,
    summary.data !== undefined &&
      calls.data !== undefined &&
      passes.data !== undefined &&
      !events.loading,
  );
  const go = useCallback(
    (tool: 'logs' | 'passes' | 'events') => () => router.history.push(wbPath(orgId, tool)),
    [router, orgId],
  );
  const seatFor = (id: Milestone): ReactNode => {
    if (moment !== id) return null;
    const m = SEAT[id];
    return (
      <Suspense fallback={null}>
        <Moment text={m.text} view={C.celebrate.view} go={go(m.tool)} />
      </Suspense>
    );
  };

  const sandbox = context.kind === 'sandbox';
  const menu = (
    <MoreMenu iconOnly>
      {sandbox ? (
        <>
          <DropdownMenuItem asChild>
            <Link to={wbPath(orgId, 'keys', { query: { new: 1 } })}>
              <KeyRound aria-hidden />
              {C.menu.newKey}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to={wbPath(orgId, 'sandbox')}>
              <RefreshCw aria-hidden />
              {C.menu.reset}
            </Link>
          </DropdownMenuItem>
        </>
      ) : null}
      <DropdownMenuItem asChild>
        <a href={adminLink(orgId)}>
          <ArrowUpRight aria-hidden />
          {C.menu.admin}
        </a>
      </DropdownMenuItem>
    </MoreMenu>
  );
  const primary = (
    <>
      <Button asChild iconStart={<SquareTerminal aria-hidden />}>
        <Link to={wbPath(orgId, 'console')}>{C.next.console}</Link>
      </Button>
      {menu}
    </>
  );

  if (sandbox && context.closed)
    return (
      <ToolPage tool="home" count={context.name} primary={menu}>
        <StageState
          scene="nudge"
          mood="sad"
          title={WB_STATES.sandboxClosed.title}
          action={
            <>
              <Button asChild>
                <Link to={wbPath(orgId, 'sandbox')}>{WB_STATES.sandboxClosed.reopen}</Link>
              </Button>
              <Button asChild variant="outline">
                <Link to="/workbench/quickstart">{WB_STATES.sandboxClosed.create}</Link>
              </Button>
            </>
          }
        />
      </ToolPage>
    );

  const q = sandbox ? summary.data?.quickstart : undefined;
  const next =
    summary.data === undefined ? (
      <Skeleton className="h-28 w-full" />
    ) : (
      <NextStep orgId={orgId} done={q?.done} total={q?.total} />
    );
  const fan = (
    <PassesFan
      orgId={orgId}
      rows={passes.data?.items}
      error={passes.error}
      onRetry={() => void passes.refetch()}
      seat={seatFor('quickstart')}
    />
  );
  return (
    <ToolPage tool="home" count={context.name} primary={primary}>
      <div className="flex min-w-0 flex-col gap-4">
        {sandbox ? null : (
          <p>
            <StatusChip tone="warning">{WB_SHELL_COPY.testDataOnly}</StatusChip>
          </p>
        )}
        <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-12">
          <div className="min-w-0 md:col-span-7 lg:col-span-8 [&>*]:h-full">{next}</div>
          <div className="min-w-0 md:col-span-5 lg:col-span-4">
            <PhoneCard
              orgId={orgId}
              link={link.data?.publicUrl}
              loading={passes.data === undefined && !passes.error}
              seat={seatFor('onPhone')}
            />
          </div>
        </div>
        <Stats orgId={orgId} summary={summary.data} />
        <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
          <RecentCalls
            orgId={orgId}
            rows={calls.data?.items}
            fresh={freshCalls}
            now={now}
            error={calls.error}
            onRetry={() => void calls.refetch()}
            seat={seatFor('firstCall')}
          />
          <RecentEventsPanel
            orgId={orgId}
            rows={events.items}
            loading={events.loading}
            error={events.error}
            fresh={freshEvents}
            now={now}
            onRetry={events.retry}
            seat={seatFor('webhook')}
          />
        </div>
        {fan}
      </div>
    </ToolPage>
  );
}
