import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import type { Mode } from '@/shared/contracts/common.ts';
import { admitsOf, type ScanEventDto, ScanEventSchema } from '@/shared/contracts/scanners.ts';
import { api } from '@/web/lib/api.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { formatEventTime } from '@/web/lib/format.ts';
import { useMode } from '@/web/lib/mode.ts';
import { useOrgScope, useResourceOrg } from '@/web/lib/org-filter.tsx';
import { useSession } from '@/web/lib/session.ts';
import { zoneLabel } from '@/web/lib/timezones.ts';
import {
  Button,
  Callout,
  Card,
  ConfirmDialog,
  DetailNotFound,
  detailError,
  KeyValue,
  PageHeader,
  ProgressBar,
  SkeletonDetail,
  StatusPill,
  TwoPane,
} from '@/web/ui/index.ts';
import { AddToSessionDialog } from './events/add-to-session-dialog.tsx';
import { EventDialog } from './events/event-dialog.tsx';
import { useOrgTemplates } from './scanner-api.ts';
import { useScanningSessions } from './sessions/api.ts';
import { SessionStatePill } from './sessions/session-state.tsx';

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
  // Live before opensAt reads Upcoming, and flips at opensAt without a reload.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const wait = event.opensAt - Date.now();
    if (wait <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(wait, 2 ** 31 - 1));
    return () => window.clearTimeout(timer);
  }, [event.opensAt]);
  const upcoming = event.status === 'live' && event.opensAt > now;
  // The scanner opens an event that is running: not one that has ended or not yet begun.
  const running = event.status === 'live' && !upcoming && event.closesAt > now;
  const [dialog, setDialog] = useState<'edit' | 'assign' | 'archive' | null>(null);
  const templates = useOrgTemplates(event.orgId);
  const sessions = useScanningSessions(event.orgId);
  const archive = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/scan-events/${encodeURIComponent(eventId)}/archive`, ScanEventSchema),
    onSuccess: () => client.invalidateQueries({ queryKey: ['admin', 'scanning'] }),
  });
  const admitting = (sessions.data?.pages.flatMap((p) => p.items) ?? []).filter(
    (s) =>
      s.orgId === event.orgId &&
      s.status !== 'ended' &&
      s.accepts !== null &&
      admitsOf(s.accepts).eventIds.includes(eventId),
  );
  const over = event.status === 'ended' || (event.status === 'live' && event.closesAt <= now);
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
              <StatusPill status={upcoming ? 'upcoming' : event.status} />
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
              {running ? (
                <Button asChild>
                  <a
                    href={`/scan?orgId=${encodeURIComponent(event.orgId)}&eventId=${encodeURIComponent(event.id)}&timeZone=${encodeURIComponent(event.timeZone)}`}
                  >
                    Open scanner
                  </a>
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      />
      {event ? (
        <TwoPane
          aside={
            <Card>
              <div className="flex flex-col gap-4 p-5">
                <h2 className="font-semibold">Sessions</h2>
                {admitting.map((s) => (
                  <div key={s.id} className="flex items-center justify-between gap-2">
                    <Link
                      className="inline-flex items-center text-accent-fg pointer-coarse:min-h-11"
                      to="/admin/o/$orgId/scanning/sessions/$sessionId"
                      params={{ orgId: s.orgId, sessionId: s.id }}
                    >
                      {s.name}
                    </Link>
                    <SessionStatePill session={s} />
                  </div>
                ))}
                {editable && !over ? (
                  <Button variant="secondary" onClick={() => setDialog('assign')}>
                    Add to a session
                  </Button>
                ) : null}
                {sessions.isError ? (
                  <Callout tone="danger">{errorMessage(sessions.error)}</Callout>
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
                <ProgressBar
                  label="Checked in"
                  value={event.arrived}
                  max={Math.max(1, event.expected)}
                  valueText={`${event.arrived} of ${event.expected} checked in`}
                  tone="success"
                />
              </div>
            </Card>
            <Card>
              <div className="flex flex-col gap-4 p-5">
                <h2 className="font-semibold">Event</h2>
                <KeyValue
                  items={[
                    { label: 'Time zone', value: zoneLabel(event.timeZone) },
                    { label: 'Capacity', value: event.capacity ?? 'No limit' },
                    { label: 'Re-entry', value: event.reentry ? 'Allowed' : 'Off' },
                    {
                      label: 'Passes',
                      value: event.match
                        ? `${event.match.input} is ${event.match.values.join(' or ')}`
                        : 'All from these templates',
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
                <Button
                  variant="ghost"
                  className="text-danger"
                  onClick={() => setDialog('archive')}
                >
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
        <AddToSessionDialog event={event} onClose={() => setDialog(null)} />
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
