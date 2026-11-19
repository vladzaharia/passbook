import { RotateCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { z } from 'zod';
import type { WebhookDeliverySchema, WebhookEndpointStatus } from '@/shared/contracts/webhooks.ts';
import { entityLabel } from '../../../lib/entity-label.ts';
import { formatDateTime } from '../../../lib/format.ts';
import type { DataColumnDef } from '../../../ui/data-table-meta.ts';
import {
  DataTable,
  EmptyState,
  ErrorState,
  IconButton,
  LoadMore,
  RowLink,
  SegmentedControl,
  StatusPill,
  toast,
} from '../../../ui/index.ts';
import { type DeliveryFilter, useDeliveries, useEndpointActions } from './api.ts';
import { DeliverySheet } from './delivery-sheet.tsx';
import { DELIVERY_STATE_LABEL, DELIVERY_STATUS, EVENT_LABEL, failureLabel } from './labels.ts';
import { queuedLine, replayError } from './replay-errors.ts';

type Delivery = z.infer<typeof WebhookDeliverySchema>;

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'failed', label: 'Failed' },
  { value: 'pending', label: 'Pending' },
] as const;

/** Why a delivery is still pending, as the pill's hover text. */
function stateHint(d: Delivery, endpointStatus: WebhookEndpointStatus): string | undefined {
  if (d.state !== 'pending') return undefined;
  if (endpointStatus === 'paused') return 'Paused: not sent until the endpoint resumes';
  if (endpointStatus === 'disabled') return 'Disabled: not sent until the endpoint resumes';
  return d.attempts === 0 ? 'Waiting to be sent' : `Retrying at ${formatDateTime(d.nextAt)}`;
}

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
  const replay = (eventId: string) => {
    setReplaying(eventId);
    replayOne
      .mutateAsync(eventId)
      .then(() => toast.success(queuedLine(1)))
      .catch((error: unknown) => toast.error(replayError(error, false), 'Could not replay'))
      .finally(() => setReplaying(undefined));
  };
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const columns: DataColumnDef<Delivery, never>[] = [
    {
      id: 'type',
      header: 'Event',
      meta: { grow: true },
      cell: ({ row: { original: d } }) => (
        <button
          type="button"
          onClick={() => setOpen(d.eventId)}
          aria-label={`${EVENT_LABEL[d.type]}, ${formatDateTime(d.lastAttemptAt ?? d.nextAt)}`}
          className="block max-w-full truncate rounded-sm text-left font-medium text-fg-strong underline-offset-2 wl-colors hover:text-accent-fg hover:underline focus-visible:outline-2 focus-visible:outline-focus"
        >
          {EVENT_LABEL[d.type]}
        </button>
      ),
    },
    {
      id: 'pass',
      header: 'Pass',
      meta: { hideBelow: 'md', nowrap: true },
      cell: ({ row: { original: d } }) => (
        <RowLink
          to="/admin/passes/$passId"
          params={{ passId: d.passId }}
          title={d.externalId ?? undefined}
          className="text-xs font-normal"
        >
          {entityLabel(d.externalId, 'Open pass')}
        </RowLink>
      ),
    },
    {
      id: 'state',
      header: 'Status',
      cell: ({ row: { original: d } }) => (
        <span title={stateHint(d, endpointStatus)}>
          <StatusPill status={DELIVERY_STATUS[d.state]}>{DELIVERY_STATE_LABEL[d.state]}</StatusPill>
        </span>
      ),
    },
    {
      id: 'attempts',
      header: 'Attempts',
      meta: { numeric: true, hideBelow: 'lg' },
      cell: ({ row: { original: d } }) => d.attempts,
    },
    {
      id: 'response',
      header: 'Response',
      meta: { nowrap: true, hideBelow: 'sm' },
      cell: ({ row: { original: d } }) =>
        d.lastAttemptAt === null ? (
          <span className="text-fg-subtle">—</span>
        ) : d.state === 'delivered' ? (
          `HTTP ${d.lastStatus ?? 200}`
        ) : (
          failureLabel(d.lastStatus, d.lastError)
        ),
    },
    ...(canManage
      ? [
          {
            id: 'actions',
            header: 'Replay',
            meta: { nowrap: true },
            cell: ({ row: { original: d } }: { row: { original: Delivery } }) => (
              <span
                title={d.state === 'pending' ? 'Pending deliveries cannot be replayed' : undefined}
              >
                <IconButton
                  label={`Replay ${EVENT_LABEL[d.type]} delivery`}
                  size="sm"
                  disabled={d.state === 'pending' || replaying === d.eventId}
                  icon={<RotateCw aria-hidden />}
                  onClick={() => replay(d.eventId)}
                />
              </span>
            ),
          },
        ]
      : []),
    {
      id: 'time',
      header: 'Last attempt',
      meta: { nowrap: true, stackHidden: true },
      cell: ({ row: { original: d } }) =>
        d.lastAttemptAt === null ? (
          <span className="text-fg-muted">Not sent</span>
        ) : (
          formatDateTime(d.lastAttemptAt)
        ),
    },
  ];
  return (
    <div className="flex flex-col gap-3">
      <SegmentedControl
        label="Show deliveries"
        options={FILTERS}
        value={filter}
        onValueChange={setFilter}
        className="self-start"
      />
      {list.isError && rows.length === 0 ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <DataTable
          caption="Deliveries"
          columns={columns}
          data={rows}
          getRowId={(d) => d.eventId}
          loading={list.isPending}
          fetching={list.isFetching && !list.isFetchingNextPage}
          bare
          empty={
            <EmptyState
              inline
              art="log"
              title={
                filter === 'all'
                  ? 'No deliveries yet'
                  : filter === 'failed'
                    ? 'No failed deliveries'
                    : 'Nothing pending'
              }
            />
          }
          footer={
            <LoadMore
              query={list}
              shown={rows.length || undefined}
              noun={['delivery', 'deliveries']}
            />
          }
        />
      )}
      <DeliverySheet
        endpointId={endpointId}
        eventId={open}
        canManage={canManage}
        endpointStatus={endpointStatus}
        onClose={() => setOpen(undefined)}
      />
    </div>
  );
}
