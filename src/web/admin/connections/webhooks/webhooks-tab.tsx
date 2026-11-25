import { Link } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useMemo } from 'react';
import type { WebhookEndpointDto } from '@/shared/contracts/webhooks.ts';
import { STATE_COPY } from '@/shared/copy/states.ts';
import { pluralize } from '@/web/lib/format.ts';
import { OrgChooser } from '@/web/ui/layout/org-chooser.tsx';
import { useMode } from '../../../lib/mode.ts';
import { useOrgScope } from '../../../lib/org-filter.tsx';
import type { DataColumnDef } from '../../../ui/data-table-meta.ts';
import {
  Button,
  Callout,
  DataTable,
  EmptyState,
  ErrorState,
  RelTime,
  RowLink,
  useNow,
} from '../../../ui/index.ts';
import { useWebhookEndpoints } from './api.ts';
import { EndpointStatus } from './endpoint-status.tsx';
import { lastDelivery } from './health.ts';
import { EVENT_LABEL } from './labels.ts';

export function AddEndpointButton({ variant = 'primary' }: { variant?: 'primary' | 'outline' }) {
  return (
    <Button asChild variant={variant} iconStart={<Plus aria-hidden />}>
      <Link to="/admin/connections/webhooks/new">Add endpoint</Link>
    </Button>
  );
}

const eventsLine = (e: WebhookEndpointDto) => e.eventTypes.map((t) => EVENT_LABEL[t]).join(', ');

/** The Webhooks tab: this mode's endpoints, at most ten, each with its health. */
export function WebhooksTab() {
  const { orgId, membership } = useOrgScope();
  const test = useMode() === 'test';
  const canRead = Boolean(membership?.capabilities.includes('integrations:read'));
  const canManage = Boolean(membership?.capabilities.includes('integrations:manage'));
  const list = useWebhookEndpoints(orgId, canRead);
  const now = useNow();
  const rows = list.data?.items ?? [];
  const columns = useMemo<DataColumnDef<WebhookEndpointDto, never>[]>(
    () => [
      {
        id: 'endpoint',
        header: 'Endpoint',
        meta: { grow: true },
        cell: ({ row: { original: e } }) => (
          <div className="min-w-0 max-w-96 contain-inline-size">
            <RowLink to="/admin/connections/webhooks/$endpointId" params={{ endpointId: e.id }}>
              {e.urlMasked}
            </RowLink>
            {e.description ? (
              <span className="block truncate text-xs text-fg-muted">{e.description}</span>
            ) : null}
          </div>
        ),
      },
      {
        id: 'events',
        header: 'Events',
        meta: { hideBelow: 'md', nowrap: true },
        cell: ({ row: { original: e } }) => (
          <span className="block max-w-56 truncate" title={eventsLine(e)}>
            {e.eventTypes.length === 1
              ? EVENT_LABEL[e.eventTypes[0] as never]
              : pluralize(e.eventTypes.length, 'event')}
          </span>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        cell: ({ row: { original: e } }) => <EndpointStatus endpoint={e} now={now} />,
      },
      {
        id: 'last',
        header: 'Last delivery',
        meta: { nowrap: true, hideBelow: 'sm' },
        cell: ({ row: { original: e } }) => {
          const last = lastDelivery(e);
          if (!last) return <span className="text-fg-subtle">None yet</span>;
          return (
            <span className="inline-flex items-center gap-1.5">
              <span className={last.ok ? 'text-fg' : 'text-danger'}>
                {last.status === null ? (last.ok ? 'Delivered' : 'Failed') : `HTTP ${last.status}`}
              </span>
              <span className="text-fg-muted">
                <RelTime at={last.at} now={now} />
              </span>
            </span>
          );
        },
      },
    ],
    [now],
  );

  if (!orgId) return <OrgChooser inline />;
  if (!canRead) return <EmptyState art="lock" title={STATE_COPY.forbidden} />;
  if (list.isError && rows.length === 0)
    return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
  return (
    <div className="flex flex-col gap-4">
      {test ? <Callout>Test endpoints get test events only.</Callout> : null}
      <DataTable
        caption="Webhook endpoints"
        columns={columns}
        data={rows}
        getRowId={(e) => e.id}
        loading={list.isPending && canRead}
        fetching={list.isFetching && !list.isPending}
        empty={
          <EmptyState
            art="plugs"
            title="No webhooks"
            action={canManage ? <AddEndpointButton /> : undefined}
          />
        }
      />
    </div>
  );
}
