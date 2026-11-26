import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowUpRight, Terminal } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { WebhookCaptureDto } from '@/shared/contracts/webhook-captures.ts';
import type { WebhookEndpointDto } from '@/shared/contracts/webhooks.ts';
import { wbPath } from '@/shared/workbench.ts';
import { DeliveryInline } from '../../admin/connections/webhooks/delivery-sheet.tsx';
import { errorMessage } from '../../lib/errors.ts';
import { useToolKey } from '../../lib/tool-api.tsx';
import { JsonViewer } from '../../ui/code-block.tsx';
import { toast } from '../../ui/toaster.tsx';
import { DeliveryList } from '../../ui/webhooks/delivery-list.tsx';
import type { DeliveryListRow } from '../../ui/webhooks/delivery-types.ts';
import { EVENT_LABEL } from '../../ui/webhooks/labels.ts';
import { IdChip } from '../bench/id-chip.tsx';
import { Inspector } from '../bench/inspector.tsx';
import { BenchTime } from '../bench/time.tsx';
import { Trace } from '../bench/trace.tsx';
import { CaptureView } from './capture-view.tsx';
import { eventDeliveryRow } from './model.ts';
import { eventInConsole } from './open-in-console.ts';
import { useHere } from './use-address.ts';
import type { FeedEvent } from './use-event-feed.ts';
import { useCaptures, useDeliveryHost, useEventDeliveries, useEventsApi } from './use-events.ts';

export interface OpenDelivery {
  endpoint?: string | undefined;
  capture?: string | undefined;
}

/**
 * One event, the root object: when, which pass, the request that caused it, then where it went
 * (the shared delivery list, one row per endpoint) and the payload. A delivery or a captured request
 * opens under the list; `?endpoint=` and `?capture=` name which.
 */
export function EventInspector({
  event,
  orgId,
  endpoints,
  open,
  onOpen,
  onPrev,
  onNext,
}: {
  event: FeedEvent;
  orgId: string;
  endpoints: readonly WebhookEndpointDto[];
  open: OpenDelivery;
  onOpen: (next: OpenDelivery) => void;
  onPrev?: (() => void) | undefined;
  onNext?: (() => void) | undefined;
}) {
  const host = useDeliveryHost();
  // Replay is one delivery's act: it sits in the delivery opened under the list, not in each row.
  const listHost = useMemo(() => ({ ...host, canManage: false }), [host]);
  const deliveries = useEventDeliveries(event.id);
  const rows = useMemo(
    () => (deliveries.data ?? []).map((d) => eventDeliveryRow(d, endpoints)),
    [deliveries.data, endpoints],
  );
  const captureEndpoint = endpoints.find((e) => e.target === 'capture');
  const captures = useCaptures(captureEndpoint?.id);
  const mine = (captures.data ?? []).filter((c) => c.eventId === event.id);
  const requestId = event.requestId;
  const opened = open.endpoint ? endpoints.find((e) => e.id === open.endpoint) : undefined;

  function pick(row: DeliveryListRow) {
    if (!('endpointId' in row) || !row.endpointId) return;
    const target = endpoints.find((e) => e.id === row.endpointId)?.target;
    if (target === 'capture') {
      const capture = mine[0];
      if (capture) onOpen({ capture: capture.id });
      else toast.info('No stored request for this event.');
    } else onOpen({ endpoint: row.endpointId });
  }
  const selected = open.endpoint ? `${open.endpoint}:${event.id}` : undefined;

  return (
    <Inspector
      title={event.type}
      label={`Event ${event.type}`}
      itemKey={event.id}
      id={<IdChip id={event.id} kind="event" />}
      actions={
        <Link className="btn ghost sm" to={eventInConsole(orgId, event.id)}>
          <Terminal aria-hidden="true" />
          Open in Console
        </Link>
      }
      facts={
        <>
          <BenchTime at={event.createdAt} mode="full" />
          <span>{EVENT_LABEL[event.type]}</span>
          {event.pass ? <IdChip id={event.pass.id} kind="pass" prefix="pass" /> : null}
          {requestId ? (
            <Link
              className="inline-flex items-center gap-1 text-accent-fg hover:underline"
              to={wbPath(orgId, 'logs', { hash: requestId })}
            >
              Request in Logs
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </Link>
          ) : null}
        </>
      }
      onPrev={onPrev}
      onNext={onNext}
      trace={
        requestId ? (
          <Trace
            nodes={[
              { kind: 'request', id: requestId, text: requestId, prefix: 'request' },
              { kind: 'event', id: event.id, text: event.type },
            ]}
          />
        ) : undefined
      }
    >
      <div className="flex min-w-0 flex-col gap-5">
        <section aria-label="Deliveries" className="flex min-w-0 flex-col gap-3">
          <h3 className="text-sm font-semibold text-fg-strong">Sent to</h3>
          <div className="min-w-0 overflow-x-auto">
            <DeliveryList
              host={listHost}
              rows={rows}
              endpointStatus="active"
              showEndpoint
              loading={deliveries.isPending}
              fetching={deliveries.isFetching}
              error={deliveries.isError ? deliveries.error : undefined}
              onRetry={() => void deliveries.refetch()}
              onOpen={pick}
              selected={selected}
              onReplay={() => undefined}
              emptyTitle="Not sent to any endpoint"
              caption="Deliveries of this event"
            />
          </div>
          {open.endpoint ? (
            <DeliveryInline
              endpointId={open.endpoint}
              eventId={event.id}
              canManage={host.canManage}
              host={host}
              endpointStatus={opened?.status ?? 'active'}
              onClose={() => onOpen({})}
            />
          ) : null}
          {open.capture ? (
            <CaptureOpen captureId={open.capture} endpoints={endpoints} onOpen={onOpen} />
          ) : null}
        </section>
        <section aria-label="Payload" className="flex min-w-0 flex-col gap-3">
          <h3 className="text-sm font-semibold text-fg-strong">Payload</h3>
          <div className="min-w-0 overflow-x-auto">
            <JsonViewer value={event} label="Event JSON" maxHeight="max-h-96" />
          </div>
        </section>
      </div>
    </Inspector>
  );
}

/** The capture `?capture=` names, found on the context's capture endpoints. */
function CaptureOpen({
  captureId,
  endpoints,
  onOpen,
}: {
  captureId: string;
  endpoints: readonly WebhookEndpointDto[];
  onOpen: (next: OpenDelivery) => void;
}) {
  const api = useEventsApi();
  const here = useHere();
  const key = useToolKey();
  const qc = useQueryClient();
  const [replaying, setReplaying] = useState(false);
  const found = useQuery({
    queryKey: ['workbench', 'events', 'capture', captureId, ...key],
    queryFn: async (): Promise<WebhookCaptureDto | null> => {
      for (const e of endpoints.filter((x) => x.target === 'capture')) {
        try {
          return await api.capture(e.id, captureId);
        } catch {
          // Not on this endpoint (a 404): the next one may hold it.
        }
      }
      return null;
    },
  });
  const capture = found.data;
  if (found.isPending)
    return (
      <p role="status" className="text-sm text-fg-muted">
        Loading the stored request…
      </p>
    );
  if (!capture)
    return (
      <p className="text-sm text-fg-muted">
        This stored request is gone. Captures are kept 7 days.
      </p>
    );
  async function replay() {
    if (!capture) return;
    setReplaying(true);
    try {
      const { capture: again } = await api.replayCapture(capture.endpointId, capture.id);
      await qc.invalidateQueries({ queryKey: ['workbench', 'events', 'captures'] });
      toast.success('Replayed. A new request is stored.');
      onOpen({ capture: again.id });
    } catch (error) {
      toast.error(errorMessage(error), 'Could not replay');
    } finally {
      setReplaying(false);
    }
  }
  return (
    <CaptureView
      key={capture.id}
      capture={capture}
      loadSecret={() => api.captureSecret(capture.endpointId)}
      next={here}
      onReplay={() => void replay()}
      replaying={replaying}
      onClose={() => onOpen({})}
    />
  );
}
