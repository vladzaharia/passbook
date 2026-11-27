import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { WB_HOME_COPY as C } from '../../../shared/copy/workbench-home.ts';
import { wbPath } from '../../../shared/workbench.ts';
import { cn } from '../../lib/cn.ts';
import { Button } from '../../ui/button.tsx';
import { CardLink } from '../../ui/card.tsx';
import { Skeleton } from '../../ui/skeleton.tsx';
import { StatusChip } from '../bench/status-chip.tsx';
import { ToolFailed } from '../states/states.tsx';
import type { CallRow, EventRow } from './data.ts';
import { At, Panel } from './panel.tsx';

const ROW =
  'wb-home-row flex min-h-11 items-center gap-3 px-4 py-2 text-sm outline-none transition-[background-color] duration-(--wl-dur-hover) ease-(--wl-ease-move) hover:bg-state-hover-tint focus-visible:bg-state-hover-tint focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus';

function Rows({ children }: { children: ReactNode }) {
  return <ul className="m-0 flex list-none flex-col divide-y divide-border p-0">{children}</ul>;
}

function Loading() {
  return (
    <div role="status" data-loading="content" className="flex flex-col gap-1 p-3">
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

function Empty({ line, action }: { line: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
      <p className="text-sm text-fg-muted">{line}</p>
      {action}
    </div>
  );
}

export function RecentCalls({
  orgId,
  rows,
  fresh,
  now,
  error,
  onRetry,
  seat,
}: {
  orgId: string;
  rows: readonly CallRow[] | undefined;
  fresh: ReadonlySet<string>;
  now: number;
  error: unknown;
  onRetry: () => void;
  seat?: ReactNode;
}) {
  let body: ReactNode;
  if (!rows) body = error ? <ToolFailed error={error} onRetry={onRetry} /> : <Loading />;
  else if (rows.length === 0) body = <Empty line={C.calls.empty} />;
  else
    body = (
      <Rows>
        {rows.map((call) => (
          <li key={call.id}>
            <Link
              to={wbPath(orgId, 'logs', { hash: call.requestId })}
              data-fresh={fresh.has(call.id) ? '' : undefined}
              className={ROW}
            >
              <span className="w-12 shrink-0 font-mono text-xs font-semibold text-fg-muted">
                {call.method}
              </span>
              <code className="min-w-0 flex-1 truncate font-mono text-[0.8125rem] text-fg-strong">
                {(call.route ?? call.path).replace(/^\/api\/v1(?=\/)/, '')}
              </code>
              <StatusChip status={call.status} />
              <span className="hidden w-14 shrink-0 text-right font-mono text-xs text-fg-muted sm:block">
                {call.durationMs} ms
              </span>
              <At at={call.at} now={now} />
            </Link>
          </li>
        ))}
      </Rows>
    );
  return (
    <Panel
      title={C.calls.title}
      seat={seat}
      actions={<CardLink to={wbPath(orgId, 'logs')}>{C.calls.all}</CardLink>}
    >
      {body}
    </Panel>
  );
}

export function RecentEventsPanel({
  orgId,
  rows,
  loading,
  error,
  fresh,
  now,
  onRetry,
  seat,
}: {
  orgId: string;
  rows: readonly EventRow[];
  loading: boolean;
  error: unknown;
  fresh: ReadonlySet<string>;
  now: number;
  onRetry: () => void;
  seat?: ReactNode;
}) {
  let body: ReactNode;
  if (loading) body = <Loading />;
  else if (error && rows.length === 0) body = <ToolFailed error={error} onRetry={onRetry} />;
  else if (rows.length === 0)
    body = (
      <Empty
        line={C.events.empty}
        action={
          <Button asChild variant="outline" size="sm">
            <Link to={wbPath(orgId, 'events', { query: { tab: 'endpoints', new: 1 } })}>
              {C.events.add}
            </Link>
          </Button>
        }
      />
    );
  else
    body = (
      <Rows>
        {rows.map((ev) => (
          <li key={ev.id}>
            <Link
              to={wbPath(orgId, 'events', { hash: ev.id })}
              data-fresh={fresh.has(ev.id) ? '' : undefined}
              className={cn(ROW)}
            >
              <code className="min-w-0 flex-1 truncate font-mono text-[0.8125rem] text-fg-strong">
                {ev.type}
              </code>
              <At at={ev.createdAt} now={now} />
            </Link>
          </li>
        ))}
      </Rows>
    );
  return (
    <Panel
      title={C.events.title}
      seat={seat}
      actions={<CardLink to={wbPath(orgId, 'events')}>{C.events.all}</CardLink>}
    >
      {body}
    </Panel>
  );
}
