import type { z } from 'zod';
import type { ConnectionRunSchema } from '@/shared/contracts/connections.ts';
import type { DataColumnDef } from '@/web/ui/data-table-meta.ts';
import { formatDateTime } from '../../lib/format.ts';
import { StatusPill } from '../../ui/index.ts';
import { errorMessage, isReplaced, outcomeLabel } from './labels.ts';

export type Run = z.infer<typeof ConnectionRunSchema>;

export const TRIGGER: Record<Run['trigger'], string> = {
  schedule: 'Schedule',
  webhook: 'Webhook',
  admin: 'Sync now',
  user: 'Holder',
  test: 'Test',
  backfill: 'Backfill',
};

export const OUTCOME: Record<Run['outcome'], { label: string; status: string; bar: string }> = {
  running: { label: 'Running', status: 'running', bar: 'bg-info' },
  unchanged: { label: 'Unchanged', status: 'unknown', bar: 'bg-border-strong' },
  changed: { label: 'Changed', status: 'complete', bar: 'bg-success' },
  error: { label: 'Failed', status: 'failed', bar: 'bg-danger' },
  skipped: { label: 'Skipped', status: 'cancelled', bar: 'bg-border' },
};

export const ms = (v: number | null) => (v === null ? null : `${Math.round(v)} ms`);

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
function runCounts(r: Run): string {
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

export const runColumns: DataColumnDef<Run, never>[] = [
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
