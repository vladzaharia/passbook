import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { useState } from 'react';
import { type ScanEventDto, ScanEventSchema } from '@/shared/contracts/scanners.ts';
import { api } from '@/web/lib/api.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { formatDateTime } from '@/web/lib/format.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import { localZone } from '@/web/lib/timezones.ts';
import {
  Button,
  Callout,
  Checkbox,
  DataTable,
  Dialog,
  DialogContent,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  Label,
} from '@/web/ui/index.ts';
import { useOrgTemplates, useScanEvents } from './scanner-api.ts';

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
  { accessorKey: 'status', header: 'Status' },
  {
    accessorKey: 'opensAt',
    header: 'Opens',
    cell: ({ row }) => formatDateTime(row.original.opensAt),
  },
  {
    accessorKey: 'arrived',
    header: 'Arrived',
    cell: ({ row }) => `${row.original.arrived} / ${row.original.expected}`,
  },
];

export function EventsTab() {
  const { orgId } = useOrgScope();
  const query = useScanEvents(orgId);
  const [creating, setCreating] = useState(false);
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const action = (
    <Button onClick={() => setCreating(true)} disabled={!orgId}>
      New event
    </Button>
  );
  return (
    <>
      {query.data?.items.length ? <div className="mb-4 flex justify-end">{action}</div> : null}
      <DataTable
        caption="Events"
        data={query.data?.items ?? []}
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
      {creating && orgId ? <EventDialog orgId={orgId} onClose={() => setCreating(false)} /> : null}
    </>
  );
}

function EventDialog({ orgId, onClose }: { orgId: string; onClose: () => void }) {
  const templates = useOrgTemplates(orgId);
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [opens, setOpens] = useState('');
  const [closes, setCloses] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [capacity, setCapacity] = useState('');
  const [note, setNote] = useState('');
  const mutation = useMutation({
    mutationFn: () =>
      api.post('/api/v1/scan-events', ScanEventSchema, {
        orgId,
        name,
        templateIds: selected,
        opensAt: new Date(opens).getTime(),
        closesAt: new Date(closes).getTime(),
        timeZone: localZone(),
        capacity: capacity ? Number(capacity) : null,
        note: note || null,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['admin', 'scanning', 'events'] });
      onClose();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogContent title="New event" size="sm">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
        >
          <FormField label="Name">
            {(p) => (
              <Input
                {...p}
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={80}
              />
            )}
          </FormField>
          <FormField label="Opens">
            {(p) => (
              <Input
                {...p}
                type="datetime-local"
                value={opens}
                onChange={(e) => setOpens(e.target.value)}
                required
              />
            )}
          </FormField>
          <FormField label="Closes">
            {(p) => (
              <Input
                {...p}
                type="datetime-local"
                value={closes}
                onChange={(e) => setCloses(e.target.value)}
                required
              />
            )}
          </FormField>
          <p className="text-sm text-fg-muted">{localZone()}</p>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Templates</legend>
            {templates.data?.items.map((t) => (
              <Label key={t.id} className="flex min-h-11 items-center gap-3">
                <Checkbox
                  checked={selected.includes(t.id)}
                  onCheckedChange={(checked) =>
                    setSelected((ids) =>
                      checked ? [...ids, t.id] : ids.filter((id) => id !== t.id),
                    )
                  }
                />
                {t.name}
              </Label>
            ))}
          </fieldset>
          <FormField label="Capacity" help="Optional">
            {(p) => (
              <Input
                {...p}
                type="number"
                min={1}
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
              />
            )}
          </FormField>
          <FormField label="Staff note" help="Optional">
            {(p) => (
              <Input
                {...p}
                maxLength={140}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            )}
          </FormField>
          {mutation.isError ? (
            <Callout tone="danger">{errorMessage(mutation.error)}</Callout>
          ) : null}
          <Button
            type="submit"
            loading={mutation.isPending}
            disabled={!name.trim() || !opens || !closes || !selected.length}
          >
            Create event
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
