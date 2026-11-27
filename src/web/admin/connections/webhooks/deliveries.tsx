import { useMemo, useState } from 'react';
import type { WebhookEndpointStatus } from '@/shared/contracts/webhooks.ts';
import { testRowOf } from '@/shared/webhook-test-rows.ts';
import { LoadMore } from '../../../ui/pagination.tsx';
import { toast } from '../../../ui/toaster.tsx';
import {
  byNewestDelivery,
  type DeliveryFilter,
  DeliveryList,
} from '../../../ui/webhooks/delivery-list.tsx';
import type { DeliveryHost, DeliveryListRow } from '../../../ui/webhooks/delivery-types.ts';
import { queuedLine, replayError } from '../../../ui/webhooks/replay-errors.ts';
import { adminDeliveryHost } from './admin-host.tsx';
import { useDeliveries, useEndpointActions, useTestSends } from './api.ts';
import { DeliveryInline, DeliverySheet } from './delivery-sheet.tsx';

/** The endpoint's deliveries, newest first. A row opens its attempts and payload. */
export function Deliveries({
  endpointId,
  canManage,
  endpointStatus,
  host: given,
  inline,
}: {
  endpointId: string;
  canManage: boolean;
  endpointStatus: WebhookEndpointStatus;
  /** Another host's links (the Workbench's); admin's by default. */
  host?: DeliveryHost;
  /** Open a delivery under the list, not in a sheet. */
  inline?: boolean;
}) {
  const [filter, setFilter] = useState<DeliveryFilter>('all');
  const [open, setOpen] = useState<string>();
  const list = useDeliveries(endpointId, filter);
  const { replayOne } = useEndpointActions(endpointId);
  const [replaying, setReplaying] = useState<string>();
  const host = useMemo(() => given ?? adminDeliveryHost(canManage), [given, canManage]);
  const replay = (eventId: string) => {
    setReplaying(eventId);
    replayOne
      .mutateAsync(eventId)
      .then(() => toast.success(queuedLine(1)))
      .catch((error: unknown) => toast.error(replayError(error, false), 'Could not replay'))
      .finally(() => setReplaying(undefined));
  };
  const tests = useTestSends(endpointId);
  const deliveries = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  // Test sends have no state: they sit in All, merged by time, and drop out of Failed and Pending.
  const rows = useMemo<DeliveryListRow[]>(
    () =>
      filter === 'all'
        ? byNewestDelivery([...deliveries, ...(tests.data?.items ?? []).map(testRowOf)])
        : deliveries,
    [deliveries, tests.data, filter],
  );
  return (
    <>
      <DeliveryList
        host={host}
        rows={rows}
        endpointStatus={endpointStatus}
        filter={{ value: filter, onChange: setFilter }}
        loading={list.isPending}
        fetching={list.isFetching && !list.isFetchingNextPage}
        error={list.isError ? list.error : undefined}
        onRetry={() => void list.refetch()}
        selected={inline && open ? `:${open}` : undefined}
        onOpen={(row) => 'eventId' in row && setOpen(row.eventId)}
        onReplay={(d) => replay(d.eventId)}
        replaying={replaying}
        footer={
          <LoadMore
            query={list}
            shown={rows.length || undefined}
            noun={['delivery', 'deliveries']}
          />
        }
      />
      {inline ? (
        <DeliveryInline
          endpointId={endpointId}
          eventId={open}
          canManage={canManage}
          host={host}
          endpointStatus={endpointStatus}
          onClose={() => setOpen(undefined)}
        />
      ) : (
        <DeliverySheet
          endpointId={endpointId}
          eventId={open}
          canManage={canManage}
          host={host}
          endpointStatus={endpointStatus}
          onClose={() => setOpen(undefined)}
        />
      )}
    </>
  );
}
