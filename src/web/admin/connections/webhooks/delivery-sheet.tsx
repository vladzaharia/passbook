import { useEffect, useMemo, useState } from 'react';
import type { WebhookEndpointStatus } from '@/shared/contracts/webhooks.ts';
import { Sheet, SheetContent, toast } from '../../../ui/index.ts';
import { DeliveryInspector } from '../../../ui/webhooks/delivery-inspector.tsx';
import { queuedLine, replayError } from '../../../ui/webhooks/replay-errors.ts';
import { useDelivery, useEndpointActions } from './api.ts';
import { adminDeliveryHost } from './deliveries.tsx';

/**
 * One delivery in a sheet: the shared inspector, with admin's host. Replay sends the same event id
 * and body again.
 */
export function DeliverySheet({
  endpointId,
  eventId,
  canManage,
  endpointStatus,
  onClose,
}: {
  endpointId: string;
  /** Why a delivery that never went out is waiting. */
  endpointStatus: WebhookEndpointStatus;
  eventId: string | undefined;
  canManage: boolean;
  onClose: () => void;
}) {
  const delivery = useDelivery(endpointId, eventId);
  const { replayOne } = useEndpointActions(endpointId);
  const [error, setError] = useState<string>();
  const host = useMemo(() => adminDeliveryHost(canManage), [canManage]);
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

  return (
    <Sheet open={eventId !== undefined} onOpenChange={(open) => !open && onClose()}>
      <SheetContent title="Delivery" className="sm:w-[480px]">
        <div className="p-4">
          <DeliveryInspector
            host={host}
            read={{
              isPending: delivery.isPending,
              isError: delivery.isError,
              data: delivery.data,
              error: delivery.error,
              refetch: () => void delivery.refetch(),
            }}
            endpointStatus={endpointStatus}
            onReplay={() => void replay()}
            replaying={replayOne.isPending}
            error={error}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
