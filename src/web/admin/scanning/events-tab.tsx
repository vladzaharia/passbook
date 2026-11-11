import { Link } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { useState } from 'react';
import type { ScanEventDto } from '@/shared/contracts/scanners.ts';
import { formatEventTime } from '@/web/lib/format.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import { Button, DataTable, EmptyState, ErrorState, StatusPill } from '@/web/ui/index.ts';
import { EventDialog } from './events/event-dialog.tsx';
import { useScanEvents } from './scanner-api.ts';

const columns: ColumnDef<ScanEventDto>[] = [
  {
    accessorKey: 'name',
    header: 'Event',
    cell: ({ row }) => (
      <Link
        to="/admin/scanning/events/$eventId"
        params={{ eventId: row.original.id }}
        className="font-medium text-accent-fg"
      >
        {row.original.name}
      </Link>
    ),
  },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }) => <StatusPill status={row.original.status} />,
  },
  {
    accessorKey: 'opensAt',
    header: 'Opens',
    cell: ({ row }) => formatEventTime(row.original.opensAt, row.original.timeZone),
  },
  {
    accessorKey: 'arrived',
    header: 'Arrived',
    cell: ({ row }) => `${row.original.arrived} / ${row.original.expected}`,
  },
  { accessorKey: 'scanners', header: 'Scanners' },
];

export function EventsTab() {
  const { orgId, membership } = useOrgScope();
  const canManage = Boolean(orgId && membership?.capabilities.includes('scanning:manage'));
  const query = useScanEvents(orgId, Boolean(orgId));
  const [creating, setCreating] = useState(false);
  const items = query.data?.items.filter((event) => event.orgId === orgId) ?? [];
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const action = canManage ? <Button onClick={() => setCreating(true)}>New event</Button> : null;
  return (
    <>
      {items.length ? <div className="mb-4 flex justify-end">{action}</div> : null}
      <DataTable
        caption="Events"
        data={items}
        columns={columns}
        loading={query.isPending}
        getRowId={(row) => row.id}
        empty={
          <EmptyState
            art="passes"
            title="No events yet"
            description={
              orgId ? 'Count arrivals at the door.' : 'Choose an organization to create an event.'
            }
            action={action}
          />
        }
      />
      {canManage && creating && orgId ? (
        <EventDialog orgId={orgId} onClose={() => setCreating(false)} />
      ) : null}
    </>
  );
}
