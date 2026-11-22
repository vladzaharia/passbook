import { RotateCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { z } from 'zod';
import type { WebhookDeliverySchema, WebhookEndpointStatus } from '@/shared/contracts/webhooks.ts';
import { TEST_TAG, type TestRow, testRowOf } from '@/shared/webhook-test-rows.ts';
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
import { type DeliveryFilter, useDeliveries, useEndpointActions, useTestSends } from './api.ts';
import { DeliverySheet } from './delivery-sheet.tsx';
import {
  DELIVERY_STATE_LABEL,
  DELIVERY_STATUS,
  EVENT_LABEL,
  failureLabel,
  responseLabel,
} from './labels.ts';
import { queuedLine, replayError } from './replay-errors.ts';

type Delivery = z.infer<typeof WebhookDeliverySchema>;
type Row = Delivery | TestRow;
const isTest = (r: Row): r is TestRow => 'key' in r;
const keyOf = (r: Row) => (isTest(r) ? r.key : r.eventId);
const atOf = (r: Row) => (isTest(r) ? r.at : (r.lastAttemptAt ?? r.nextAt));

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
  const tests = useTestSends(endpointId);
  const deliveries = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  // Test sends have no state: they sit in All, merged by time, and drop out of Failed and Pending.
  const rows = useMemo<Row[]>(
    () =>
      filter === 'all'
        ? [...deliveries, ...(tests.data?.items ?? []).map(testRowOf)].sort(
            (a, b) => atOf(b) - atOf(a),
          )
        : deliveries,
    [deliveries, tests.data, filter],
  );
  const columns: DataColumnDef<Row, never>[] = [
    {
      id: 'type',
      header: 'Event',
      meta: { grow: true },
      cell: ({ row: { original: d } }) =>
        isTest(d) ? (
          <span className="flex items-center gap-2 font-medium text-fg-strong">
            {EVENT_LABEL[d.type]}
            <StatusPill status="neutral">{TEST_TAG}</StatusPill>
          </span>
        ) : (
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
      cell: ({ row: { original: d } }) =>
        isTest(d) ? (
          <span className="text-fg-subtle">—</span>
        ) : (
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
      cell: ({ row: { original: d } }) =>
        isTest(d) ? (
          <StatusPill status={d.ok ? 'success' : 'danger'}>{d.ok ? 'Sent' : 'Failed'}</StatusPill>
        ) : (
          <span title={stateHint(d, endpointStatus)}>
            <StatusPill status={DELIVERY_STATUS[d.state]}>
              {DELIVERY_STATE_LABEL[d.state]}
            </StatusPill>
          </span>
        ),
    },
    {
      id: 'attempts',
      header: 'Attempts',
      meta: { numeric: true, hideBelow: 'lg' },
      cell: ({ row: { original: d } }) => (isTest(d) ? 1 : d.attempts),
    },
    {
      id: 'response',
      header: 'Response',
      meta: { nowrap: true, hideBelow: 'sm' },
      cell: ({ row: { original: d } }) =>
        isTest(d) ? (
          d.status === null ? (
            failureLabel(null, d.errorCode)
          ) : (
            `HTTP ${d.status}`
          )
        ) : d.lastAttemptAt === null ? (
          <span className="text-fg-subtle">—</span>
        ) : d.state === 'delivered' ? (
          `HTTP ${d.lastStatus ?? 200}`
        ) : d.state === 'failed' ? (
          failureLabel(d.lastStatus, d.lastError)
        ) : (
          // A pending or cancelled delivery has no verdict: say what came back, or nothing.
          responseLabel(d.lastStatus, d.lastError) || <span className="text-fg-subtle">—</span>
        ),
    },
    ...(canManage
      ? [
          {
            id: 'actions',
            header: 'Replay',
            meta: { nowrap: true },
            cell: ({ row: { original: d } }: { row: { original: Row } }) =>
              isTest(d) ? null : (
                <span
                  title={
                    d.state === 'pending' ? 'Pending deliveries cannot be replayed' : undefined
                  }
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
      meta: { nowrap: true },
      cell: ({ row: { original: d } }) =>
        isTest(d) ? (
          formatDateTime(d.at)
        ) : d.lastAttemptAt === null ? (
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
          getRowId={keyOf}
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
