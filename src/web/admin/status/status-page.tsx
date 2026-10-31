import { RefreshCw } from 'lucide-react';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  ErrorState,
  KeyValue,
  PageHeader,
  SkeletonRows,
  StatusPill,
} from '@/web/ui/index.ts';
import { formatDateTime } from '../overview/format.ts';
import { sortBySeverity, useStatus, useWorkflowRuns } from './queries.ts';

const RUN_STATUS: Record<string, 'verified' | 'degraded' | 'failing' | 'configured'> = {
  complete: 'verified',
  running: 'configured',
  queued: 'configured',
  errored: 'failing',
  terminated: 'degraded',
};

function Workflows() {
  const runs = useWorkflowRuns();
  return (
    <Card>
      <CardHeader title="Recent workflow runs" />
      <CardBody>
        {runs.isPending ? (
          <SkeletonRows rows={3} label="Loading workflow runs" />
        ) : runs.isError ? (
          <ErrorState error={runs.error} onRetry={() => runs.refetch()} />
        ) : (
          <DataTable
            caption="Workflow runs"
            data={runs.data.items}
            getRowId={(r) => r.instanceId}
            empty={<EmptyState title="No workflow runs" />}
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
      </CardBody>
    </Card>
  );
}

export function StatusPage() {
  const status = useStatus();
  const refresh = (
    <Button
      variant="outline"
      iconStart={<RefreshCw aria-hidden />}
      loading={status.isFetching && !status.isPending}
      onClick={() => status.refetch()}
    >
      Refresh
    </Button>
  );
  return (
    <>
      <PageHeader title="Status" actions={refresh} />
      {status.isPending ? (
        <SkeletonRows label="Loading status" />
      ) : status.isError ? (
        <ErrorState error={status.error} onRetry={() => status.refetch()} />
      ) : (
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <span className="flex items-center gap-2">
              Overall <StatusPill status={status.data.overall} />
            </span>
            <span className="text-fg-muted">
              Build {status.data.build.tag ?? status.data.build.id ?? 'unknown'}
              {status.data.build.timestamp ? `, ${status.data.build.timestamp}` : ''}
            </span>
          </div>
          {status.data.components.length === 0 ? (
            <EmptyState title="No components reported" />
          ) : (
            <ul className="flex flex-col gap-2" aria-label="Components">
              {sortBySeverity(status.data.components).map((c) => (
                <li key={c.id}>
                  <Card className="p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium text-fg-strong">{c.label}</p>
                        <p className="text-xs text-fg-muted">
                          {c.kind}, checked {formatDateTime(c.checkedAt)}
                        </p>
                      </div>
                      <StatusPill status={c.state} />
                    </div>
                    {c.detail ? <p className="mt-2 text-sm text-fg">{c.detail}</p> : null}
                    {c.data && Object.keys(c.data).length > 0 ? (
                      <KeyValue
                        className="mt-3"
                        items={Object.entries(c.data).map(([label, value]) => ({
                          label,
                          value: value === null ? null : String(value),
                          mono: true,
                        }))}
                      />
                    ) : null}
                  </Card>
                </li>
              ))}
            </ul>
          )}
          <Workflows />
        </div>
      )}
    </>
  );
}
