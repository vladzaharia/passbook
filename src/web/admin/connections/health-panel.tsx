import { Link } from '@tanstack/react-router';
import { Pause } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import type { ConnectionDetailSchema } from '@/shared/contracts/connections.ts';
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
  Tooltip,
} from '../../ui/index.ts';
import { healthSentence, overdue } from './health-text.ts';
import { errorMessage } from './labels.ts';
import { ms, OUTCOME, type Run, runColumns, TRIGGER } from './run-columns.tsx';
import './connections.css';

type Detail = z.infer<typeof ConnectionDetailSchema>;

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
  const awaiting = c.health === 'awaiting';
  const waiting = !awaiting && pushOnly && !c.lastRunAt && !failing;
  return (
    <div className="flex min-w-0 flex-col gap-6">
      {c.warning ? <Callout tone="warning">{c.warning.text}</Callout> : null}
      <Card>
        <CardHeader title="Health" />
        <CardBody className="flex flex-col gap-4">
          <div className="relative flex flex-wrap items-center justify-between gap-3">
            <p className={cn('text-sm', failing ? 'text-fg-strong' : 'text-fg')}>
              {waiting ? 'Waiting for the first webhook. ' : healthSentence(c, now, since)}{' '}
              {awaiting ? (
                <Link
                  to="/admin/connections/$connectionId/setup"
                  params={{ connectionId: c.id }}
                  className="font-medium text-fg-strong underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-focus"
                >
                  Finish setup
                </Link>
              ) : null}
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
          columns={runColumns}
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
