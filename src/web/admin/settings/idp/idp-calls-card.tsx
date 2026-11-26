import { useMemo, useState } from 'react';
import { CALL_PHASE } from '@/shared/copy/idp-platform.ts';
import { formatDateTime } from '@/web/lib/format.ts';
import { humanizeStatus } from '@/web/lib/status.ts';
import type { DataColumnDef } from '@/web/ui/data-table-meta.ts';
import {
  Button,
  Card,
  CardHeader,
  DataTable,
  EmptyState,
  ErrorState,
  LoadMore,
  Select,
} from '@/web/ui/index.ts';
import { useCalls } from './idp-queries.ts';

interface Call {
  id: number;
  phase: string;
  method: string;
  target: string | null;
  actor: string | null;
  reason: string | null;
  status: string | null;
  at: number;
}

const RANGES = [
  { value: '3600000', label: 'Last hour' },
  { value: '86400000', label: 'Last 24 hours' },
  { value: '604800000', label: 'Last 7 days' },
];

const COLUMNS: DataColumnDef<Call, never>[] = [
  {
    header: 'Time',
    id: 'at',
    meta: { nowrap: true },
    cell: ({ row }) => formatDateTime(row.original.at),
  },
  {
    header: 'Call',
    id: 'call',
    cell: ({ row }) => (
      <div className="min-w-0">
        <code className="font-mono text-xs text-fg-strong">{row.original.method}</code>
        {row.original.target ? (
          <code className="block truncate font-mono text-xs text-fg-muted">
            {row.original.target}
          </code>
        ) : null}
      </div>
    ),
  },
  {
    header: 'Phase',
    id: 'phase',
    meta: { nowrap: true },
    cell: ({ row }) => CALL_PHASE[row.original.phase] ?? humanizeStatus(row.original.phase),
  },
  {
    header: 'Result',
    id: 'status',
    meta: { hideBelow: 'lg' },
    cell: ({ row }) => {
      const { status, reason } = row.original;
      return (
        <span className="text-fg-muted">{[status, reason].filter(Boolean).join(' · ') || '—'}</span>
      );
    },
  },
  {
    header: 'By',
    id: 'actor',
    meta: { hideBelow: 'xl', nowrap: true },
    cell: ({ row }) => row.original.actor ?? '—',
  },
];

/** The binding's ledger of calls to Polaris ID: ids, methods and codes, never a value. Loads when opened. */
export function IdpCallsCard() {
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState(RANGES[1]?.value ?? '86400000');
  // The window start is fixed per choice, so the query key holds still while it is open.
  const since = useMemo(() => (open ? Date.now() - Number(range) : 0), [open, range]);
  const calls = useCalls(since, open);
  const rows = useMemo(() => calls.data?.pages.flatMap((p) => p.items) ?? [], [calls.data]);
  return (
    <Card>
      <CardHeader
        title="Calls"
        actions={
          <>
            {open ? (
              <Select
                label="Range"
                options={RANGES}
                value={range}
                onValueChange={setRange}
                className="w-auto"
              />
            ) : null}
            <Button size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? 'Hide' : 'Show calls'}
            </Button>
          </>
        }
      />
      {open ? (
        calls.isError && rows.length === 0 ? (
          <div className="p-4">
            <ErrorState
              inline
              subject="calls"
              error={calls.error}
              onRetry={() => calls.refetch()}
            />
          </div>
        ) : (
          <DataTable
            bare
            caption="Polaris ID calls"
            loading={calls.isPending}
            fetching={calls.isFetching && !calls.isPending && !calls.isFetchingNextPage}
            data={rows}
            getRowId={(c) => String(c.id)}
            columns={COLUMNS}
            empty={<EmptyState inline art="log" title="No calls" />}
            footer={<LoadMore query={calls} shown={rows.length} noun={['call', 'calls']} />}
          />
        )
      ) : null}
    </Card>
  );
}
