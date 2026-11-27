import { X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { WebhookEndpointStatus } from '@/shared/contracts/webhooks.ts';
import { IconButton } from '../../../ui/icon-button.tsx';
import { Sheet, SheetContent } from '../../../ui/sheet.tsx';
import { toast } from '../../../ui/toaster.tsx';
import { DeliveryInspector } from '../../../ui/webhooks/delivery-inspector.tsx';
import type { DeliveryHost } from '../../../ui/webhooks/delivery-types.ts';
import { queuedLine, replayError } from '../../../ui/webhooks/replay-errors.ts';
import { adminDeliveryHost } from './admin-host.tsx';
import { useDelivery, useEndpointActions } from './api.ts';

interface OpenProps {
  endpointId: string;
  /** Why a delivery that never went out is waiting. */
  endpointStatus: WebhookEndpointStatus;
  eventId: string | undefined;
  canManage: boolean;
  host?: DeliveryHost | undefined;
  onClose: () => void;
}

/** One delivery's read, replay and refusal: the sheet and the inline view share it. */
function useDeliveryView({ endpointId, eventId, canManage, host, onClose }: OpenProps) {
  const delivery = useDelivery(endpointId, eventId);
  const { replayOne } = useEndpointActions(endpointId);
  const [error, setError] = useState<string>();
  const chosen = useMemo(() => host ?? adminDeliveryHost(canManage), [host, canManage]);
  // The view stays mounted: a refusal belongs to the delivery it came from.
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
  return { delivery, host: chosen, error, replay, replaying: replayOne.isPending };
}

function Body(props: OpenProps & { view: ReturnType<typeof useDeliveryView> }) {
  const { view } = props;
  const { delivery } = view;
  return (
    <DeliveryInspector
      host={view.host}
      read={{
        isPending: delivery.isPending,
        isError: delivery.isError,
        data: delivery.data,
        error: delivery.error,
        refetch: () => void delivery.refetch(),
      }}
      endpointStatus={props.endpointStatus}
      onReplay={() => void view.replay()}
      replaying={view.replaying}
      error={view.error}
    />
  );
}

/**
 * One delivery in a sheet: the shared inspector, with admin's host. Replay sends the same event id
 * and body again.
 */
export function DeliverySheet(props: OpenProps) {
  const view = useDeliveryView(props);
  return (
    <Sheet open={props.eventId !== undefined} onOpenChange={(open) => !open && props.onClose()}>
      <SheetContent title="Delivery" className="sm:w-[480px]">
        <div className="p-4">
          <Body {...props} view={view} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * The same delivery in place, under its list: where a sheet would sit under a pane that is itself a
 * dialog (the Workbench's inspector below 1180 px).
 */
export function DeliveryInline(props: OpenProps) {
  const view = useDeliveryView(props);
  if (props.eventId === undefined) return null;
  return (
    <section aria-label="Delivery" className="mt-2 flex flex-col gap-3 border-t border-border pt-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-fg-strong">Delivery</h3>
        <IconButton
          label="Close delivery"
          size="sm"
          icon={<X aria-hidden />}
          onClick={props.onClose}
        />
      </div>
      <Body {...props} view={view} />
    </section>
  );
}
