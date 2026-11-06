import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ScanEventSchema } from '@/shared/contracts/scanners.ts';
import { api } from '@/web/lib/api.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { formatDateTime } from '@/web/lib/format.ts';
import { useMode } from '@/web/lib/mode.ts';
import { Button, Callout, Card, ErrorState, PageHeader } from '@/web/ui/index.ts';

export function EventPage({ eventId }: { eventId: string }) {
  const client = useQueryClient();
  const mode = useMode();
  const query = useQuery({
    queryKey: ['admin', 'scanning', 'events', eventId],
    queryFn: ({ signal }) =>
      api.get(`/api/v1/scan-events/${encodeURIComponent(eventId)}`, ScanEventSchema, { signal }),
    refetchInterval: 30_000,
  });
  const archive = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/scan-events/${encodeURIComponent(eventId)}/archive`, ScanEventSchema),
    onSuccess: () => client.invalidateQueries({ queryKey: ['admin', 'scanning', 'events'] }),
  });
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const event = query.data;
  return (
    <>
      <PageHeader
        title={event?.name ?? 'Event'}
        breadcrumbs={[
          { label: 'Scanning', to: '/admin/scanning' },
          { label: event?.name ?? 'Event' },
        ]}
        actions={
          event && event.mode === mode && event.status !== 'archived' ? (
            <Button
              variant="secondary"
              onClick={() => archive.mutate()}
              loading={archive.isPending}
            >
              Archive event
            </Button>
          ) : undefined
        }
      />
      {event ? (
        <Card>
          <div className="flex flex-col gap-3 p-4">
            <p>
              {event.status} · {event.arrived} of {event.expected} arrived
            </p>
            <p>
              {formatDateTime(event.opensAt)} – {formatDateTime(event.closesAt)} · {event.timeZone}
            </p>
            {event.capacity ? <p>Capacity {event.capacity}</p> : null}
            {event.note ? <p>{event.note}</p> : null}
            <p>{event.scanners} scanners assigned</p>
            <Button asChild variant="secondary">
              <a
                href={`/scan?orgId=${encodeURIComponent(event.orgId)}&eventId=${encodeURIComponent(event.id)}&timeZone=${encodeURIComponent(event.timeZone)}`}
              >
                Open scanner
              </a>
            </Button>
          </div>
        </Card>
      ) : null}
      {archive.isError ? <Callout tone="danger">{errorMessage(archive.error)}</Callout> : null}
    </>
  );
}
