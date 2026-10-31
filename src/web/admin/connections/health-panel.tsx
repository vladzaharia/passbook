import type { ColumnDef } from '@tanstack/react-table';
import type { z } from 'zod';
import type {
  ConnectionDetailSchema,
  ConnectionRunSchema,
} from '@/shared/contracts/connections.ts';
import { Card, CardBody, CardHeader, DataTable, EmptyState, KeyValue } from '../../ui/index.ts';
import { formatDate } from '../passes/format.ts';
import { HealthPill } from './health.tsx';

type Detail = z.infer<typeof ConnectionDetailSchema>;
type Run = z.infer<typeof ConnectionRunSchema>;

const ms = (v: number | null) => (v === null ? null : `${Math.round(v)} ms`);

/** Sampled record errors, one per line; collapsed until opened. */
function SampledErrors({ detail }: { detail: string | null | undefined }) {
  if (!detail) return null;
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
    cell: ({ row }) => formatDate(row.original.startedAt),
  },
  {
    id: 'trigger',
    header: 'Trigger',
    enableSorting: false,
    cell: ({ row }) => row.original.trigger,
  },
  {
    id: 'outcome',
    header: 'Outcome',
    enableSorting: false,
    cell: ({ row }) => row.original.outcome,
  },
  {
    id: 'code',
    header: 'Code',
    enableSorting: false,
    cell: ({ row }) => <span className="font-mono text-xs">{row.original.errorCode ?? ''}</span>,
  },
  {
    id: 'http',
    header: 'HTTP',
    enableSorting: false,
    cell: ({ row }) => row.original.httpStatus ?? '',
  },
  {
    id: 'records',
    header: 'Records',
    enableSorting: false,
    cell: ({ row }) =>
      row.original.recordsSeen === null
        ? ''
        : `${row.original.recordsSeen} seen, ${row.original.passesChanged ?? 0} changed`,
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
    cell: ({ row }) => ms(row.original.durationMs) ?? '',
  },
];

export function HealthPanel({ connection: c }: { connection: Detail }) {
  return (
    <div className="grid gap-4">
      <Card className="max-w-2xl">
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
              { label: 'Last error', value: c.lastErrorCode, mono: true },
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
      <Card>
        <CardHeader title="Last 20 runs" />
        <CardBody>
          <DataTable
            caption="Connection runs"
            columns={columns}
            data={c.runs.slice(0, 20)}
            getRowId={(r) => r.id}
            empty={<EmptyState title="No runs yet" />}
          />
        </CardBody>
      </Card>
    </div>
  );
}
