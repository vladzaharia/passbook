import type { ColumnDef } from '@tanstack/react-table';
import { Pause } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import type {
  ConnectionDetailSchema,
  ConnectionRunSchema,
} from '@/shared/contracts/connections.ts';
import { ACTION_ICON } from '../../lib/action-icons.ts';
import { cn } from '../../lib/cn.ts';
import { formatDateTime } from '../../lib/format.ts';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Celebrate,
  DataTable,
  EmptyState,
  KeyValue,
  StatusPill,
  Tooltip,
} from '../../ui/index.ts';
import { clock, healthSentence, overdue } from './health-text.ts';
import { errorMessage } from './labels.ts';
import './connections.css';

type Detail = z.infer<typeof ConnectionDetailSchema>;
type Run = z.infer<typeof ConnectionRunSchema>;

const TRIGGER: Record<Run['trigger'], string> = {
  schedule: 'Schedule',
  webhook: 'Webhook',
  admin: 'Sync now',
  user: 'Holder',
  test: 'Test',
  backfill: 'Backfill',
};

const OUTCOME: Record<Run['outcome'], { label: string; status: string; bar: string }> = {
  running: { label: 'Running', status: 'running', bar: 'bg-info' },
  unchanged: { label: 'Unchanged', status: 'unknown', bar: 'bg-border-strong' },
  changed: { label: 'Changed', status: 'complete', bar: 'bg-success' },
  error: { label: 'Failed', status: 'failed', bar: 'bg-danger' },
  skipped: { label: 'Skipped', status: 'cancelled', bar: 'bg-border' },
};

const ms = (v: number | null) => (v === null ? null : `${Math.round(v)} ms`);

/** Sampled record errors, one per line; collapsed until opened. */
function SampledErrors({ detail }: { detail: string | null | undefined }) {
  if (!detail) return <>—</>;
  const lines = detail.split('\n');
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-accent-fg">
        {lines.length} sampled {lines.length === 1 ? 'error' : 'errors'}
      </summary>
      <pre className="mt-1 max-w-md whitespace-pre-wrap break-words font-mono text-fg-muted">
        {detail}
      </pre>
    </details>
  );
}

const columns: ColumnDef<Run, never>[] = [
  {
    id: 'started',
    header: 'Started',
    meta: { nowrap: true },
    cell: ({ row }) => formatDateTime(row.original.startedAt),
  },
  { id: 'trigger', header: 'Trigger', cell: ({ row }) => TRIGGER[row.original.trigger] },
  {
    id: 'outcome',
    header: 'Outcome',
    cell: ({ row }) => {
      const o = OUTCOME[row.original.outcome];
      return <StatusPill status={o.status}>{o.label}</StatusPill>;
    },
  },
  {
    id: 'records',
    header: 'Records',
    meta: { nowrap: true },
    cell: ({ row }) =>
      row.original.recordsSeen === null
        ? '—'
        : `${row.original.recordsSeen} seen, ${row.original.passesChanged ?? 0} changed`,
  },
  {
    id: 'code',
    header: 'Code',
    cell: ({ row }) =>
      row.original.errorCode ? (
        <span
          className="font-mono text-xs text-fg-muted"
          title={errorMessage(row.original.errorCode) ?? undefined}
        >
          {row.original.errorCode}
          {row.original.httpStatus ? ` · ${row.original.httpStatus}` : ''}
        </span>
      ) : (
        '—'
      ),
  },
  {
    id: 'errors',
    header: 'Errors',
    cell: ({ row }) => <SampledErrors detail={row.original.errorDetail} />,
  },
  {
    id: 'duration',
    header: 'Duration',
    meta: { numeric: true },
    cell: ({ row }) => ms(row.original.durationMs) ?? '—',
  },
];

/** The last 20 runs as bars, oldest first: green changed, grey unchanged, red failed. */
function RunStrip({ runs }: { runs: readonly Run[] }) {
  const last = [...runs.slice(0, 20)].reverse();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs text-fg-muted">Last {last.length} runs</span>
      <ol aria-label="Recent runs" className="flex h-6 items-end gap-1">
        {last.map((r) => (
          <li key={r.id} className="flex h-full min-w-0 flex-1 max-w-3">
            <Tooltip
              content={`${OUTCOME[r.outcome].label} · ${TRIGGER[r.trigger]} · ${formatDateTime(r.startedAt)}`}
            >
              <span
                role="img"
                aria-label={`${OUTCOME[r.outcome].label}, ${formatDateTime(r.startedAt)}`}
                className={cn('block h-full w-full rounded-sm', OUTCOME[r.outcome].bar)}
              />
            </Tooltip>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** True once a value turns from empty to set while the page is open (not on first load). */
function useBecameSet(value: unknown): boolean {
  const first = useRef(value);
  const [fired, setFired] = useState(false);
  useEffect(() => {
    if (!first.current && value && !fired) setFired(true);
    if (!first.current && value) first.current = value;
  }, [value, fired]);
  return fired;
}

export function HealthPanel({
  connection: c,
  onRetry,
  retrying,
  canSync,
}: {
  connection: Detail;
  onRetry: () => void;
  retrying: boolean;
  canSync: boolean;
}) {
  const now = Date.now();
  const failing = c.consecutiveFailures > 0;
  const breaker = c.breakerOpenUntil !== null && c.breakerOpenUntil > now;
  const firstSync = useBecameSet(c.lastSuccessAt);
  const opened = useBecameSet(breaker ? c.breakerOpenUntil : null);
  const since = c.runs.find(
    (r, i) => r.outcome === 'error' && c.runs[i + 1]?.outcome !== 'error',
  )?.startedAt;
  const late = overdue(c, now);
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Card>
        <CardHeader title="Health" />
        <CardBody className="flex flex-col gap-4">
          <div className="relative flex flex-wrap items-center justify-between gap-3">
            <p className={cn('text-sm', failing ? 'text-fg-strong' : 'text-fg')}>
              {healthSentence(c, now, since)}
            </p>
            {failing && canSync ? (
              <Button
                variant="outline"
                size="sm"
                busy="spin"
                loading={retrying}
                iconStart={<ACTION_ICON.refresh aria-hidden />}
                onClick={onRetry}
              >
                Retry now
              </Button>
            ) : null}
            <Celebrate when={firstSync} />
          </div>
          {c.lastErrorCode ? (
            <Callout tone={failing ? 'danger' : 'warning'} title="Last error">
              {errorMessage(c.lastErrorCode)}{' '}
              <span className="font-mono text-xs text-fg-muted">
                {c.lastErrorCode}
                {c.lastErrorAt ? ` · ${formatDateTime(c.lastErrorAt)}` : ''}
              </span>
            </Callout>
          ) : null}
          {late ? (
            <Callout tone="warning">
              The next run was due {clock(c.nextRunAt ?? now, now)} and has not started.
            </Callout>
          ) : null}
          {c.runs.length ? <RunStrip runs={c.runs} /> : null}
          <KeyValue
            items={[
              { label: 'Last run', value: c.lastRunAt ? formatDateTime(c.lastRunAt) : null },
              {
                label: 'Last success',
                value: c.lastSuccessAt ? formatDateTime(c.lastSuccessAt) : null,
              },
              {
                label: 'Next run',
                value: c.nextRunAt ? (
                  <span className={cn(late && 'text-warning')}>{formatDateTime(c.nextRunAt)}</span>
                ) : null,
              },
              {
                label: 'Paused after repeated failures',
                value: breaker ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Pause
                      aria-hidden
                      className={cn('size-4 text-warning', opened && 'wl-breaker-pulse')}
                    />
                    Until {formatDateTime(c.breakerOpenUntil)}
                  </span>
                ) : (
                  'No'
                ),
              },
              {
                label: 'Latency p50 / p95',
                value:
                  c.metrics.p50Ms === null
                    ? null
                    : `${ms(c.metrics.p50Ms)} / ${ms(c.metrics.p95Ms) ?? '—'}`,
              },
              {
                label: 'Error rate',
                value:
                  c.metrics.errorRate === null
                    ? null
                    : `${(c.metrics.errorRate * 100).toFixed(1)}%`,
              },
            ]}
          />
        </CardBody>
      </Card>
      <Card className="min-w-0">
        <CardHeader title="Runs" />
        <DataTable
          caption="Connection runs"
          bare
          stack={false}
          columns={columns}
          data={c.runs.slice(0, 20)}
          getRowId={(r) => r.id}
          empty={<EmptyState inline art="runs" title="No runs yet" />}
        />
      </Card>
    </div>
  );
}
