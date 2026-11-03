import { Link } from '@tanstack/react-router';
import type { z } from 'zod';
import type { WorkflowRunSchema } from '@/shared/contracts/status.ts';
import {
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  ErrorState,
  SkeletonRows,
  StatusPill,
} from '@/web/ui/index.ts';
import { formatDateTime } from '../../lib/format.ts';
import { workflowErrorMessage, workflowKindLabel } from './labels.ts';
import { useWorkflowRuns } from './queries.ts';

type Run = z.infer<typeof WorkflowRunSchema>;

/**
 * The page a run acted on. A finished import names its template; a rejected one only has its
 * upload, whose report lives on the upload page.
 */
export function runLink(r: Run): { to: string; search?: Record<string, string> } | undefined {
  if (!r.targetId) return undefined;
  if (r.kind === 'connection_sync') return { to: `/admin/connections/${r.targetId}` };
  if (r.kind === 'template_import' && r.targetId === r.instanceId)
    return { to: '/admin/templates/upload', search: { upload: r.instanceId } };
  return { to: `/admin/templates/${r.targetId}` };
}

export function WorkflowRuns({ orgName }: { orgName: (id: string | null) => string | undefined }) {
  const runs = useWorkflowRuns();
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Recent workflow runs" />
      {runs.isPending ? (
        <CardBody>
          <SkeletonRows rows={3} label="Loading workflow runs" />
        </CardBody>
      ) : runs.isError ? (
        <CardBody>
          <ErrorState inline error={runs.error} onRetry={() => runs.refetch()} />
        </CardBody>
      ) : (
        <DataTable
          caption="Workflow runs"
          bare
          className="[&_td:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:first-child]:pl-4 [&_th:last-child]:pr-4"
          stack={false}
          data={runs.data.items}
          getRowId={(r) => r.instanceId}
          empty={<EmptyState inline art="runs" title="No workflow runs" />}
          columns={[
            {
              header: 'Workflow',
              id: 'kind',
              cell: ({ row }) => {
                const link = runLink(row.original);
                const label = workflowKindLabel(row.original.kind);
                return link ? (
                  <Link
                    to={link.to}
                    search={link.search}
                    className="font-medium text-accent-fg hover:underline"
                  >
                    {label}
                  </Link>
                ) : (
                  label
                );
              },
            },
            {
              header: 'Status',
              id: 'status',
              cell: ({ row }) => <StatusPill status={row.original.status} />,
            },
            {
              header: 'Organization',
              id: 'org',
              meta: { nowrap: true, hideBelow: 'lg' },
              cell: ({ row }) =>
                orgName(row.original.orgId) ?? <span className="text-fg-subtle">—</span>,
            },
            {
              header: 'Started',
              id: 'started',
              meta: { nowrap: true },
              cell: ({ row }) => formatDateTime(row.original.startedAt),
            },
            {
              header: 'Error',
              id: 'error',
              cell: ({ row }) =>
                row.original.errorCode ? (
                  // One line, so error rows keep the table's row height.
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span>{workflowErrorMessage(row.original.kind, row.original.errorCode)}</span>
                    <code className="font-mono text-xs text-fg-muted">
                      {row.original.errorCode}
                    </code>
                  </div>
                ) : (
                  <span className="text-fg-subtle">—</span>
                ),
            },
          ]}
        />
      )}
    </Card>
  );
}
