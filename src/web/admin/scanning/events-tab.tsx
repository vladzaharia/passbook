import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { admitsOf, type ScanEventDto } from '@/shared/contracts/scanners.ts';
import { formatEventTime } from '@/web/lib/format.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import type { DataColumnDef } from '@/web/ui/data-table-meta.ts';
import { Button, DataTable, EmptyState, ErrorState, StatusPill } from '@/web/ui/index.ts';
import { EventDialog } from './events/event-dialog.tsx';
import { useScanEvents } from './scanner-api.ts';
import { useScanningSessions } from './sessions/api.ts';

const eventColumns = (sessionsOf: (id: string) => number): DataColumnDef<ScanEventDto>[] => [
  {
    accessorKey: 'name',
    header: 'Event',
    cell: ({ row }) => (
      <Link
        to="/admin/scanning/events/$eventId"
        params={{ eventId: row.original.id }}
        className="inline-flex items-center font-medium text-accent-fg pointer-coarse:min-h-11"
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
  {
    id: 'sessions',
    header: 'Sessions',
    cell: ({ row }) => sessionsOf(row.original.id),
  },
];

export function EventsTab() {
  const { orgId, membership } = useOrgScope();
  const canManage = Boolean(orgId && membership?.capabilities.includes('scanning:manage'));
  const query = useScanEvents(orgId, Boolean(orgId));
  const [creating, setCreating] = useState(false);
  const sessions = useScanningSessions(orgId);
  const columns = useMemo(() => {
    const rows = sessions.data?.pages.flatMap((p) => p.items) ?? [];
    return eventColumns(
      (id) =>
        rows.filter(
          (s) => s.status !== 'ended' && s.accepts && admitsOf(s.accepts).eventIds.includes(id),
        ).length,
    );
  }, [sessions.data]);
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
        empty={<EmptyState art="passes" title="No events yet" action={action} />}
      />
      {canManage && creating && orgId ? (
        <EventDialog orgId={orgId} onClose={() => setCreating(false)} />
      ) : null}
    </>
  );
}
