import { Pause } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import type {
  ConnectionDetailSchema,
  ConnectionRunSchema,
} from '@/shared/contracts/connections.ts';
import type { DataColumnDef } from '@/web/ui/data-table-meta.ts';
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
import { healthSentence, overdue } from './health-text.ts';
import { errorMessage, isReplaced, outcomeLabel } from './labels.ts';
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

/** "12 seen · 3 created · 1 voided · 2 failed"; runs from before the counts show seen and changed. */
export function runCounts(r: Run): string {
  if (r.recordsSeen === null) return '—';
  if (r.passesCreated === null) return `${r.recordsSeen} seen, ${r.passesChanged ?? 0} changed`;
  const updated = Math.max(0, (r.passesChanged ?? 0) - r.passesCreated - (r.passesVoided ?? 0));
  return [
    `${r.recordsSeen} seen`,
    r.passesCreated ? `${r.passesCreated} created` : null,
    updated ? `${updated} updated` : null,
    r.passesVoided ? `${r.passesVoided} voided` : null,
    r.recordsFailed ? `${r.recordsFailed} failed` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

const columns: DataColumnDef<Run, never>[] = [
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
      return <StatusPill status={o.status}>{outcomeLabel(row.original, o.label)}</StatusPill>;
    },
  },
  {
    id: 'records',
    header: 'Records',
    meta: { nowrap: true },
    cell: ({ row }) => (row.original.recordsSeen === null ? '—' : runCounts(row.original)),
  },
  {
    id: 'code',
    header: 'Code',
    cell: ({ row }) =>
      row.original.errorCode && !isReplaced(row.original) ? (
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

const LEGEND: readonly Run['outcome'][] = ['changed', 'unchanged', 'error'];
const LEGEND_HINT: Partial<Record<Run['outcome'], string>> = {
  unchanged: 'Ran, nothing to update',
};

/** The last 20 runs as bars, oldest first: green changed, grey unchanged, red failed. */
function RunStrip({ runs }: { runs: readonly Run[] }) {
  const last = [...runs.slice(0, 20)].reverse();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs text-fg-muted">
        Last {last.length} {last.length === 1 ? 'run' : 'runs'}
      </span>
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
      <ul aria-label="Legend" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
        {LEGEND.map((o) => (
          <li key={o} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={cn('size-2.5 rounded-sm', OUTCOME[o].bar)} />
            {OUTCOME[o].label}
            {LEGEND_HINT[o] ? (
              <span className="text-fg-subtle">{`, ${LEGEND_HINT[o]?.toLowerCase()}`}</span>
            ) : null}
          </li>
        ))}
      </ul>
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

const RUNS_SHOWN = 5;

export function HealthPanel({
  connection: c,
  onRetry,
  retrying,
  canSync,
  pushOnly,
  onWebhookTab,
}: {
  connection: Detail;
  onRetry: () => void;
  retrying: boolean;
  canSync: boolean;
  /** Nothing to poll: the source pushes webhooks. */
  pushOnly: boolean;
  /** Opens the Webhook tab; set when the connection receives pushes. */
  onWebhookTab?: (() => void) | undefined;
}) {
  const now = Date.now();
  const [allRuns, setAllRuns] = useState(false);
  const failing = c.consecutiveFailures > 0;
  const breaker = c.breakerOpenUntil !== null && c.breakerOpenUntil > now;
  const firstSync = useBecameSet(c.lastSuccessAt);
  const opened = useBecameSet(breaker ? c.breakerOpenUntil : null);
  const since = c.runs.find(
    (r, i) => r.outcome === 'error' && c.runs[i + 1]?.outcome !== 'error',
  )?.startedAt;
  const late = overdue(c, now);
  const waiting = pushOnly && !c.lastRunAt && !failing;
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Card>
        <CardHeader title="Health" />
        <CardBody className="flex flex-col gap-4">
          <div className="relative flex flex-wrap items-center justify-between gap-3">
            <p className={cn('text-sm', failing ? 'text-fg-strong' : 'text-fg')}>
              {waiting ? 'Waiting for the first webhook. ' : healthSentence(c, now, since)}
              {waiting && onWebhookTab ? (
                <Button variant="link" onClick={onWebhookTab}>
                  Open webhook setup
                </Button>
              ) : null}
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
          {c.runs.length ? <RunStrip runs={c.runs} /> : null}
          <KeyValue
            items={[
              {
                label: pushOnly ? 'Last webhook' : 'Last run',
                value: c.lastRunAt ? formatDateTime(c.lastRunAt) : null,
              },
              {
                label: 'Last success',
                value: c.lastSuccessAt ? formatDateTime(c.lastSuccessAt) : null,
              },
              ...(pushOnly
                ? []
                : [
                    {
                      label: 'Next run',
                      value: c.nextRunAt ? (
                        <span className={cn(late && 'text-warning')}>
                          {formatDateTime(c.nextRunAt)}
                        </span>
                      ) : null,
                    },
                  ]),
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
                label: 'Latency, typical / slow',
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
          columns={columns}
          data={c.runs.slice(0, allRuns ? 20 : RUNS_SHOWN)}
          getRowId={(r) => r.id}
          empty={<EmptyState inline art="runs" title="No runs yet" />}
          footer={
            c.runs.length > RUNS_SHOWN ? (
              <Button variant="link" onClick={() => setAllRuns((v) => !v)}>
                {allRuns ? 'Show fewer' : `Show all ${Math.min(20, c.runs.length)}`}
              </Button>
            ) : undefined
          }
        />
      </Card>
    </div>
  );
}
