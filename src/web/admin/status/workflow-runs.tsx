import {
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  SkeletonRows,
  StatusPill,
} from '@/web/ui/index.ts';
import { formatDateTime } from '../overview/format.ts';
import { useWorkflowRuns } from './queries.ts';

const RUN_STATUS: Record<string, 'verified' | 'degraded' | 'failing' | 'configured'> = {
  complete: 'verified',
  running: 'configured',
  queued: 'configured',
  errored: 'failing',
  terminated: 'degraded',
};

export function WorkflowRuns() {
  const runs = useWorkflowRuns();
  return (
    <section aria-labelledby="runs-heading" className="flex flex-col gap-2">
      <h2 id="runs-heading" className="text-base font-semibold text-fg-strong">
        Recent workflow runs
      </h2>
      <Card className="overflow-hidden p-4">
        {runs.isPending ? (
          <SkeletonRows rows={3} label="Loading workflow runs" />
        ) : runs.isError ? (
          <ErrorState error={runs.error} onRetry={() => runs.refetch()} />
        ) : (
          <DataTable
            caption="Workflow runs"
            data={runs.data.items}
            getRowId={(r) => r.instanceId}
            empty={<EmptyState className="border-0 py-6" title="No workflow runs" />}
            columns={[
              { header: 'Kind', accessorKey: 'kind' },
              {
                header: 'Status',
                accessorKey: 'status',
                cell: ({ row }) => (
                  <StatusPill status={RUN_STATUS[row.original.status] ?? 'configured'}>
                    {row.original.status}
                  </StatusPill>
                ),
              },
              {
                header: 'Started',
                accessorKey: 'startedAt',
                cell: ({ row }) => formatDateTime(row.original.startedAt),
              },
              {
                header: 'Error',
                accessorKey: 'errorCode',
                cell: ({ row }) =>
                  row.original.errorCode ? (
                    <code className="font-mono text-xs">{row.original.errorCode}</code>
                  ) : (
                    ''
                  ),
              },
            ]}
          />
        )}
      </Card>
    </section>
  );
}
