import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Mode } from '@/shared/contracts/common.ts';
import {
  type ScanEventDto,
  ScanEventSchema,
  ScannerListSchema,
} from '@/shared/contracts/scanners.ts';
import { api } from '@/web/lib/api.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { formatEventTime } from '@/web/lib/format.ts';
import { useMode } from '@/web/lib/mode.ts';
import { useOrgScope, useResourceOrg } from '@/web/lib/org-filter.tsx';
import { useSession } from '@/web/lib/session.ts';
import {
  Button,
  Callout,
  Card,
  ConfirmDialog,
  DetailNotFound,
  detailError,
  KeyValue,
  PageHeader,
  SkeletonDetail,
  StatusPill,
  TwoPane,
} from '@/web/ui/index.ts';
import { AssignDialog } from './events/assign-dialog.tsx';
import { EventDialog } from './events/event-dialog.tsx';
import { useOrgTemplates } from './scanner-api.ts';

export function EventPage({ eventId }: { eventId: string }) {
  const { hasExplicitOrg, requestedOrgId } = useOrgScope();
  return (
    <EventResource key={`${eventId}:${hasExplicitOrg}:${requestedOrgId ?? ''}`} eventId={eventId} />
  );
}

function EventResource({ eventId }: { eventId: string }) {
  const scope = useOrgScope();
  const mode = useMode();
  const query = useQuery({
    queryKey: ['admin', 'scanning', 'events', eventId],
    queryFn: ({ signal }) =>
      api.get(`/api/v1/scan-events/${encodeURIComponent(eventId)}`, ScanEventSchema, { signal }),
    refetchOnMount: 'always',
    refetchInterval: 30_000,
  });
  const event = query.data;
  const resourceScope = useResourceOrg(
    query.isFetchedAfterMount && !query.isError ? event?.orgId : undefined,
  );
  const header = (
    <PageHeader
      title="Event"
      breadcrumbs={[{ label: 'Scanning', to: '/admin/scanning' }, { label: 'Event' }]}
    />
  );
  if (resourceScope === 'not-found') {
    return (
      <>
        {header}
        <DetailNotFound entity="event" to="/admin/scanning" back="scanning" />
      </>
    );
  }
  if (query.isError) {
    return detailError(query, { entity: 'event', to: '/admin/scanning', back: 'scanning', header });
  }
  if (!event || resourceScope !== 'ready' || scope.orgId !== event.orgId) {
    return (
      <>
        {header}
        <SkeletonDetail label="Loading event" />
      </>
    );
  }
  const canManage = Boolean(scope.membership?.capabilities.includes('scanning:manage'));
  return (
    <EventDetail
      key={`${event.id}:${event.orgId}:${canManage}:${mode}`}
      event={event}
      canManage={canManage}
      mode={mode}
    />
  );
}

function EventDetail({
  event,
  canManage,
  mode,
}: {
  event: ScanEventDto;
  canManage: boolean;
  mode: Mode;
}) {
  const eventId = event.id;
  const client = useQueryClient();
  const { membership } = useOrgScope();
  const { isAdmin } = useSession();
  const canAuthor = Boolean(
    membership?.capabilities.includes('templates:read') &&
      membership.capabilities.includes('templates:author'),
  );
  const [dialog, setDialog] = useState<'edit' | 'assign' | 'archive' | null>(null);
  const templates = useOrgTemplates(event.orgId);
  const scanners = useQuery({
    queryKey: ['admin', 'scanning', 'event-scanners', eventId, event.orgId],
    queryFn: ({ signal }) =>
      api.get('/api/v1/scanners', ScannerListSchema, {
        query: { orgId: event.orgId, limit: 200 },
        signal,
      }),
    refetchInterval: 30_000,
  });
  const archive = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/scan-events/${encodeURIComponent(eventId)}/archive`, ScanEventSchema),
    onSuccess: () => client.invalidateQueries({ queryKey: ['admin', 'scanning'] }),
  });
  const assigned =
    scanners.data?.items.filter(
      (s) =>
        s.orgId === event.orgId &&
        s.status !== 'revoked' &&
        s.accepts &&
        'eventId' in s.accepts &&
        s.accepts.eventId === eventId,
    ) ?? [];
  const editable = canManage && event.mode === mode && event.status !== 'archived';
  return (
    <>
      <PageHeader
        title={event?.name ?? 'Event'}
        breadcrumbs={[
          { label: 'Scanning', to: '/admin/scanning' },
          { label: event?.name ?? 'Event' },
        ]}
        meta={
          event ? (
            <>
              <StatusPill status={event.status} />
              <span>
                {formatEventTime(event.opensAt, event.timeZone)} –{' '}
                {formatEventTime(event.closesAt, event.timeZone)}
              </span>
            </>
          ) : undefined
        }
        actions={
          editable ? (
            <>
              <Button variant="secondary" onClick={() => setDialog('edit')}>
                Edit event
              </Button>
              <Button asChild>
                <a
                  href={`/scan?orgId=${encodeURIComponent(event.orgId)}&eventId=${encodeURIComponent(event.id)}&timeZone=${encodeURIComponent(event.timeZone)}`}
                >
                  Open scanner
                </a>
              </Button>
            </>
          ) : undefined
        }
      />
      {event ? (
        <TwoPane
          aside={
            <Card>
              <div className="flex flex-col gap-4 p-5">
                <h2 className="font-semibold">Readiness</h2>
                <p>
                  {assigned.filter((s) => s.status === 'paired').length} of {assigned.length}{' '}
                  scanners paired
                </p>
                {assigned.map((s) => (
                  <div key={s.id} className="flex items-center justify-between gap-2">
                    <a
                      className="text-accent-fg"
                      href={`/admin/scanning/scanners/${encodeURIComponent(s.id)}`}
                    >
                      {s.name}
                    </a>
                    <StatusPill status={s.status} />
                  </div>
                ))}
                {editable ? (
                  <Button variant="secondary" onClick={() => setDialog('assign')}>
                    Assign scanners
                  </Button>
                ) : null}
                {scanners.isError ? (
                  <Callout tone="danger">{errorMessage(scanners.error)}</Callout>
                ) : null}
              </div>
            </Card>
          }
        >
          <div className="flex flex-col gap-5">
            <Card>
              <div className="p-5">
                <p className="text-sm text-fg-muted">Checked in</p>
                <p className="my-3 text-4xl font-semibold tabular-nums">
                  {event.arrived}{' '}
                  <span className="text-lg font-normal text-fg-muted">of {event.expected}</span>
                </p>
                <progress
                  className="h-2 w-full accent-accent"
                  value={event.arrived}
                  max={Math.max(1, event.expected)}
                  aria-label="Checked in"
                  aria-valuetext={`${event.arrived} of ${event.expected} checked in`}
                />
              </div>
            </Card>
            <Card>
              <div className="flex flex-col gap-4 p-5">
                <h2 className="font-semibold">Event</h2>
                <KeyValue
                  items={[
                    { label: 'Time zone', value: event.timeZone },
                    { label: 'Capacity', value: event.capacity ?? 'No limit' },
                    { label: 'Re-entry', value: event.reentry ? 'Allowed' : 'Off' },
                    {
                      label: 'Only passes where',
                      value: event.match
                        ? `${event.match.input} = ${event.match.values.join(', ')}`
                        : 'All passes of these templates',
                    },
                  ]}
                />
                {event.note ? (
                  <Callout tone="info">
                    <strong>Note for staff</strong>
                    <p>{event.note}</p>
                  </Callout>
                ) : null}
                {templates.data?.items
                  .filter(
                    (t) =>
                      (t.orgId === null || t.orgId === event.orgId) &&
                      event.templateIds.includes(t.id),
                  )
                  .map((t) => (
                    <p key={t.id} className="text-sm">
                      Result screen: {t.name}
                      {canAuthor && (t.orgId !== null || t.origin === 'baked' || isAdmin) ? (
                        <>
                          {' · '}
                          <a
                            className="text-accent-fg"
                            href={`/admin/templates/${encodeURIComponent(t.id)}/design?mode=scan`}
                          >
                            Edit
                          </a>
                        </>
                      ) : null}
                    </p>
                  ))}
              </div>
            </Card>
            {editable ? (
              <div>
                <Button variant="ghost" onClick={() => setDialog('archive')}>
                  Archive event
                </Button>
              </div>
            ) : null}
          </div>
        </TwoPane>
      ) : null}
      {editable && dialog === 'edit' ? (
        <EventDialog orgId={event.orgId} event={event} onClose={() => setDialog(null)} />
      ) : null}
      {editable && dialog === 'assign' ? (
        <AssignDialog event={event} onClose={() => setDialog(null)} />
      ) : null}
      <ConfirmDialog
        open={editable && dialog === 'archive'}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title="Archive event?"
        description="Scanners will be detached. Past scans stay in the log."
        confirmLabel="Archive event"
        onConfirm={() => archive.mutateAsync().then(() => undefined)}
      />
    </>
  );
}
