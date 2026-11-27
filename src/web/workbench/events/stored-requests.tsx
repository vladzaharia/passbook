import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { WebhookCaptureDto } from '@/shared/contracts/webhook-captures.ts';
import type { WebhookEndpointDto } from '@/shared/contracts/webhooks.ts';
import { errorMessage } from '../../lib/errors.ts';
import { toast } from '../../ui/toaster.tsx';
import { DeliveryList } from '../../ui/webhooks/delivery-list.tsx';
import { CaptureView } from './capture-view.tsx';
import { captureRow } from './model.ts';
import { useHere } from './use-address.ts';
import { useCaptures, useDeliveryHost, useEventsApi } from './use-events.ts';

/** What a capture endpoint stored, in the shared list; one opens in place. */
export function StoredRequests({
  endpoint,
  open,
  onOpen,
}: {
  endpoint: WebhookEndpointDto;
  open: string | undefined;
  onOpen: (id: string | undefined) => void;
}) {
  const api = useEventsApi();
  const here = useHere();
  const qc = useQueryClient();
  const host = useDeliveryHost();
  const list = useCaptures(endpoint.id);
  const [replaying, setReplaying] = useState(false);
  const rows = useMemo(
    () => (list.data ?? []).map((c) => captureRow(c, endpoint)),
    [list.data, endpoint],
  );
  const found = useQuery({
    queryKey: ['workbench', 'events', 'stored', endpoint.id, open],
    queryFn: () => api.capture(endpoint.id, open as string),
    enabled: Boolean(open) && !(list.data ?? []).some((c) => c.id === open),
    retry: false,
  });
  const shown: WebhookCaptureDto | undefined =
    (list.data ?? []).find((c) => c.id === open) ?? found.data;
  return (
    <>
      <DeliveryList
        host={{ ...host, canManage: false }}
        rows={rows}
        endpointStatus={endpoint.status}
        loading={list.isPending}
        fetching={list.isFetching}
        error={list.isError ? list.error : undefined}
        onRetry={() => void list.refetch()}
        onOpen={(row) => 'rowId' in row && onOpen(row.rowId)}
        selected={open}
        onReplay={() => undefined}
        emptyTitle="Nothing stored yet"
        caption="Stored requests"
      />
      {shown ? (
        <CaptureView
          key={shown.id}
          capture={shown}
          loadSecret={() => api.captureSecret(endpoint.id)}
          next={here}
          replaying={replaying}
          onReplay={() => {
            setReplaying(true);
            api
              .replayCapture(endpoint.id, shown.id)
              .then(async ({ capture }) => {
                await qc.invalidateQueries({ queryKey: ['workbench', 'events'] });
                toast.success('Replayed. A new request is stored.');
                onOpen(capture.id);
              })
              .catch((error: unknown) => toast.error(errorMessage(error), 'Could not replay'))
              .finally(() => setReplaying(false));
          }}
          onClose={() => onOpen(undefined)}
        />
      ) : null}
    </>
  );
}
