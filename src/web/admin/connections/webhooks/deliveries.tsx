import { useMemo, useState } from 'react';
import type { WebhookEndpointStatus } from '@/shared/contracts/webhooks.ts';
import { testRowOf } from '@/shared/webhook-test-rows.ts';
import { LoadMore, RowLink, toast } from '../../../ui/index.ts';
import {
  byNewestDelivery,
  DeliveryList,
  type DeliveryFilter,
} from '../../../ui/webhooks/delivery-list.tsx';
import type { DeliveryHost, DeliveryListRow } from '../../../ui/webhooks/delivery-types.ts';
import { queuedLine, replayError } from '../../../ui/webhooks/replay-errors.ts';
import { useDeliveries, useEndpointActions, useTestSends } from './api.ts';
import { DeliverySheet } from './delivery-sheet.tsx';

/** Admin's host for the shared delivery parts: a pass is an admin page, and a manager replays. */
export const adminDeliveryHost = (canManage: boolean): DeliveryHost => ({
  canManage,
  passLink: ({ passId, externalId, label }, place) => (
    <RowLink
      to="/admin/passes/$passId"
      params={{ passId }}
      title={externalId ?? undefined}
      className={place === 'list' ? 'text-xs font-normal' : 'font-normal'}
    >
      {label}
    </RowLink>
  ),
});

/** The endpoint's deliveries, newest first. A row opens its attempts and payload. */
export function Deliveries({
  endpointId,
  canManage,
  endpointStatus,
}: {
  endpointId: string;
  canManage: boolean;
  endpointStatus: WebhookEndpointStatus;
}) {
  const [filter, setFilter] = useState<DeliveryFilter>('all');
  const [open, setOpen] = useState<string>();
  const list = useDeliveries(endpointId, filter);
  const { replayOne } = useEndpointActions(endpointId);
  const [replaying, setReplaying] = useState<string>();
  const host = useMemo(() => adminDeliveryHost(canManage), [canManage]);
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
      <DeliverySheet
        endpointId={endpointId}
        eventId={open}
        canManage={canManage}
        endpointStatus={endpointStatus}
        onClose={() => setOpen(undefined)}
      />
    </>
  );
}
