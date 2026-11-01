import type { ColumnDef } from '@tanstack/react-table';
import type { z } from 'zod';
import type {
  ConnectionDetailSchema,
  ConnectionRunSchema,
} from '@/shared/contracts/connections.ts';
import { Card, CardBody, CardHeader, DataTable, KeyValue, StatusPill } from '../../ui/index.ts';
import { formatDate } from '../passes/format.ts';
import { ErrorLine } from './error-line.tsx';
import { HealthPill } from './health.tsx';
import { errorMessage } from './labels.ts';

type Detail = z.infer<typeof ConnectionDetailSchema>;
type Run = z.infer<typeof ConnectionRunSchema>;

const TRIGGER: Record<Run['trigger'], string> = {
  schedule: 'Schedule',
  webhook: 'Webhook',
  admin: 'Admin',
  user: 'Holder',
  test: 'Test',
  backfill: 'Backfill',
};

const OUTCOME: Record<
  Run['outcome'],
  { label: string; tone: 'info' | 'neutral' | 'success' | 'danger' }
> = {
  running: { label: 'Running', tone: 'info' },
  unchanged: { label: 'Unchanged', tone: 'neutral' },
  changed: { label: 'Changed', tone: 'success' },
  error: { label: 'Failed', tone: 'danger' },
  skipped: { label: 'Skipped', tone: 'neutral' },
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
    enableSorting: false,
    cell: ({ row }) => (
      <span className="whitespace-nowrap">{formatDate(row.original.startedAt)}</span>
    ),
  },
  {
    id: 'trigger',
    header: 'Trigger',
    enableSorting: false,
    cell: ({ row }) => TRIGGER[row.original.trigger],
  },
  {
    id: 'outcome',
    header: 'Outcome',
    enableSorting: false,
    cell: ({ row }) => {
      const o = OUTCOME[row.original.outcome];
      return (
        <StatusPill status={row.original.outcome} tone={o.tone}>
          {o.label}
        </StatusPill>
      );
    },
  },
  {
    id: 'code',
    header: 'Code',
    enableSorting: false,
    cell: ({ row }) =>
      row.original.errorCode ? (
        <span
          className="font-mono text-xs text-danger"
          title={errorMessage(row.original.errorCode) ?? undefined}
        >
          {row.original.errorCode}
        </span>
      ) : (
        '—'
      ),
  },
  {
    id: 'http',
    header: 'HTTP',
    enableSorting: false,
    cell: ({ row }) => row.original.httpStatus ?? '—',
  },
  {
    id: 'records',
    header: 'Records',
    enableSorting: false,
    cell: ({ row }) =>
      row.original.recordsSeen === null ? (
        '—'
      ) : (
        <span className="whitespace-nowrap">
          {row.original.recordsSeen} seen, {row.original.passesChanged ?? 0} changed
        </span>
      ),
  },
  {
    id: 'errors',
    header: 'Errors',
    enableSorting: false,
    cell: ({ row }) => <SampledErrors detail={row.original.errorDetail} />,
  },
  {
    id: 'duration',
    header: 'Duration',
    enableSorting: false,
    cell: ({ row }) => ms(row.original.durationMs) ?? '—',
  },
];

export function HealthPanel({ connection: c }: { connection: Detail }) {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Card>
        <CardHeader title="Health" />
        <CardBody>
          <KeyValue
            items={[
              { label: 'Status', value: <HealthPill health={c.enabled ? c.health : 'disabled'} /> },
              { label: 'Last run', value: formatDate(c.lastRunAt) },
              { label: 'Last success', value: formatDate(c.lastSuccessAt) },
              { label: 'Next run', value: c.nextRunAt ? formatDate(c.nextRunAt) : null },
              { label: 'Failures in a row', value: String(c.consecutiveFailures) },
              {
                label: 'Breaker',
                value:
                  c.breakerOpenUntil && c.breakerOpenUntil > Date.now()
                    ? `Open until ${formatDate(c.breakerOpenUntil)}`
                    : 'Closed',
              },
              {
                label: 'Last error',
                value: c.lastErrorCode ? <ErrorLine code={c.lastErrorCode} /> : null,
              },
              {
                label: 'Latency p50 / p95',
                value: `${ms(c.metrics.p50Ms) ?? 'n/a'} / ${ms(c.metrics.p95Ms) ?? 'n/a'}`,
              },
              {
                label: 'Error rate',
                value:
                  c.metrics.errorRate === null
                    ? 'n/a'
                    : `${(c.metrics.errorRate * 100).toFixed(1)}%`,
              },
              { label: 'Passes', value: String(c.metrics.passCount) },
            ]}
          />
        </CardBody>
      </Card>
      <Card className="min-w-0">
        <CardHeader title="Last 20 runs" />
        <CardBody className="p-0">
          <DataTable
            caption="Connection runs"
            bare
            stack={false}
            columns={columns}
            data={c.runs.slice(0, 20)}
            getRowId={(r) => r.id}
            empty={<p className="p-4 text-sm text-fg-muted">No runs yet.</p>}
          />
        </CardBody>
      </Card>
    </div>
  );
}
