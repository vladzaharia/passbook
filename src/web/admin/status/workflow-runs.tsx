import {
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  SkeletonRows,
  StatusPill,
} from '@/web/ui/index.ts';
import { formatDateTime } from '../overview/format.ts';
import { workflowErrorMessage, workflowKindLabel } from './labels.ts';
import { useWorkflowRuns } from './queries.ts';

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
            bare
            stack={false}
            data={runs.data.items}
            getRowId={(r) => r.instanceId}
            empty={<EmptyState inline art="runs" title="No workflow runs" />}
            columns={[
              {
                header: 'Kind',
                accessorKey: 'kind',
                cell: ({ row }) => (
                  <span className="whitespace-nowrap">{workflowKindLabel(row.original.kind)}</span>
                ),
              },
              {
                header: 'Status',
                accessorKey: 'status',
                cell: ({ row }) => <StatusPill status={row.original.status} />,
              },
              {
                header: 'Started',
                accessorKey: 'startedAt',
                cell: ({ row }) => (
                  <span className="whitespace-nowrap">
                    {formatDateTime(row.original.startedAt)}
                  </span>
                ),
              },
              {
                header: 'Error',
                accessorKey: 'errorCode',
                cell: ({ row }) =>
                  row.original.errorCode ? (
                    <div className="min-w-0">
                      <p>{workflowErrorMessage(row.original.kind, row.original.errorCode)}</p>
                      <code className="font-mono text-xs text-fg-muted">
                        {row.original.errorCode}
                      </code>
                    </div>
                  ) : (
                    '—'
                  ),
              },
            ]}
          />
        )}
      </Card>
    </section>
  );
}
