import { RotateCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatDateTime } from '../../../lib/format.ts';
import {
  Button,
  Callout,
  ErrorState,
  JsonViewer,
  KeyValue,
  Sheet,
  SheetContent,
  Skeleton,
  StatusPill,
  Timeline,
  type TimelineItem,
  toast,
} from '../../../ui/index.ts';
import { useDelivery, useEndpointActions } from './api.ts';
import {
  DELIVERY_STATE_LABEL,
  DELIVERY_STATUS,
  EVENT_LABEL,
  failureLabel,
  TRIGGER_LABEL,
} from './labels.ts';
import { queuedLine, replayError } from './replay-errors.ts';

/**
 * One delivery: what happened on each attempt and the exact payload (an allowlist, no holder
 * data, so it is safe to show). Replay sends the same event id and body again.
 */
export function DeliverySheet({
  endpointId,
  eventId,
  canManage,
  onClose,
}: {
  endpointId: string;
  eventId: string | undefined;
  canManage: boolean;
  onClose: () => void;
}) {
  const delivery = useDelivery(endpointId, eventId);
  const { replayOne } = useEndpointActions(endpointId);
  const [error, setError] = useState<string>();
  const d = delivery.data;
  // The sheet stays mounted: a refusal belongs to the delivery it came from.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when another delivery opens
  useEffect(() => setError(undefined), [eventId]);

  async function replay() {
    if (!eventId) return;
    setError(undefined);
    try {
      await replayOne.mutateAsync(eventId);
      toast.success(queuedLine(1));
      onClose();
    } catch (cause) {
      setError(replayError(cause, false));
    }
  }

  const attempts: TimelineItem[] = (d?.attemptLog ?? []).map((a) => {
    const ok = a.status !== null && a.status >= 200 && a.status < 300;
    return {
      id: String(a.attempt),
      title: `${TRIGGER_LABEL[a.trigger]}: ${ok ? `HTTP ${a.status}` : failureLabel(a.status, a.errorCode)}`,
      time: a.at,
      description: `${a.durationMs} ms`,
      tone: ok ? 'success' : 'danger',
    };
  });

  return (
    <Sheet open={eventId !== undefined} onOpenChange={(open) => !open && onClose()}>
      <SheetContent title="Delivery" className="sm:w-[480px]">
        <div className="flex flex-col gap-5 p-4">
          {delivery.isPending ? (
            <div role="status" aria-label="Loading delivery" className="flex flex-col gap-3">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : delivery.isError || !d ? (
            <ErrorState error={delivery.error} onRetry={() => void delivery.refetch()} />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill status={DELIVERY_STATUS[d.state]}>
                  {DELIVERY_STATE_LABEL[d.state]}
                </StatusPill>
                <span className="text-sm font-medium text-fg-strong">{EVENT_LABEL[d.type]}</span>
              </div>
              <KeyValue
                items={[
                  { label: 'Event id', value: d.eventId, mono: true },
                  { label: 'Pass', value: d.externalId ?? d.passId, mono: true },
                  { label: 'Attempts', value: String(d.attempts) },
                  { label: 'Replays', value: String(d.replays) },
                  {
                    label: d.state === 'pending' ? 'Next attempt' : 'Finished',
                    value: formatDateTime(d.state === 'pending' ? d.nextAt : d.finishedAt, '—'),
                  },
                ]}
              />
              {error ? <Callout tone="danger">{error}</Callout> : null}
              {canManage ? (
                <Button
                  variant="outline"
                  className="self-start"
                  busy="spin"
                  loading={replayOne.isPending}
                  disabled={d.state === 'pending'}
                  iconStart={<RotateCw aria-hidden />}
                  onClick={() => void replay()}
                >
                  Replay
                </Button>
              ) : null}
              <div>
                <h3 className="mb-3 text-sm font-semibold text-fg-strong">Attempts</h3>
                {attempts.length === 0 ? (
                  <p className="text-sm text-fg-muted">No attempts yet.</p>
                ) : (
                  <Timeline items={attempts} />
                )}
              </div>
              <div>
                <h3 className="mb-3 text-sm font-semibold text-fg-strong">Payload</h3>
                <JsonViewer value={d.payload} label="Payload JSON" maxHeight="max-h-80" />
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
