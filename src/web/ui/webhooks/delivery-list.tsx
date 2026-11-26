import { RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';
import type { WebhookEndpointStatus } from '@/shared/contracts/webhooks.ts';
import { TEST_TAG } from '@/shared/webhook-test-rows.ts';
import { formatDateTime } from '../../lib/format.ts';
import type { DataColumnDef } from '../data-table-meta.ts';
import { DataTable, EmptyState, ErrorState, IconButton, SegmentedControl, StatusPill } from '../index.ts';
import {
  type Delivery,
  type DeliveryHost,
  type DeliveryListRow,
  isTestRow,
  rowKey,
} from './delivery-types.ts';
import {
  DELIVERY_STATE_LABEL,
  DELIVERY_STATUS,
  EVENT_LABEL,
  failureLabel,
  passLabel,
  responseLabel,
} from './labels.ts';

export type DeliveryFilter = 'all' | 'failed' | 'pending';

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'failed', label: 'Failed' },
  { value: 'pending', label: 'Pending' },
] as const;

const EMPTY: Record<DeliveryFilter, string> = {
  all: 'No deliveries yet',
  failed: 'No failed deliveries',
  pending: 'Nothing pending',
};

const atOf = (r: DeliveryListRow) => (isTestRow(r) ? r.at : (r.lastAttemptAt ?? r.nextAt));

/** Newest first: test sends sit among the deliveries by time. */
export const byNewestDelivery = (rows: readonly DeliveryListRow[]): DeliveryListRow[] =>
  [...rows].sort((a, b) => atOf(b) - atOf(a));

/** Why a delivery is still pending, as the pill's hover text. */
function stateHint(d: Delivery, endpointStatus: WebhookEndpointStatus): string | undefined {
  if (d.state !== 'pending') return undefined;
  if (endpointStatus === 'paused') return 'Paused: not sent until the endpoint resumes';
  if (endpointStatus === 'disabled') return 'Disabled: not sent until the endpoint resumes';
  return d.attempts === 0 ? 'Waiting to be sent' : `Retrying at ${formatDateTime(d.nextAt)}`;
}

export interface DeliveryListProps {
  host: DeliveryHost;
  rows: DeliveryListRow[];
  /** The endpoint the rows belong to, for the pending hint, when a row names none. */
  endpointStatus: WebhookEndpointStatus;
  /** An event's list spans endpoints: the endpoint is a column. */
  showEndpoint?: boolean;
  filter?: { value: DeliveryFilter; onChange: (value: DeliveryFilter) => void };
  loading: boolean;
  fetching?: boolean;
  error?: unknown;
  onRetry?: () => void;
  onOpen: (row: DeliveryListRow) => void;
  /** The row open in the inspector. */
  selected?: string | undefined;
  onReplay: (row: Delivery & { endpointId?: string }) => void;
  /** The key of the row whose replay is out. */
  replaying?: string | undefined;
  footer?: ReactNode;
  caption?: string;
  /** Overrides the empty line. */
  emptyTitle?: string;
}

/**
 * Deliveries, newest first, in one table for both hosts: the endpoint's own list in admin and an
 * event's list across endpoints in the Workbench. A row opens the delivery inspector.
 */
export function DeliveryList({
  host,
  rows,
  endpointStatus,
  showEndpoint,
  filter,
  loading,
  fetching,
  error,
  onRetry,
  onOpen,
  selected,
  onReplay,
  replaying,
  footer,
  caption = 'Deliveries',
  emptyTitle,
}: DeliveryListProps) {
  const label = (d: Delivery) =>
    `${EVENT_LABEL[d.type]}, ${formatDateTime(d.lastAttemptAt ?? d.nextAt)}`;
  const columns: DataColumnDef<DeliveryListRow, never>[] = [
    {
      id: 'type',
      header: 'Event',
      meta: { grow: true },
      cell: ({ row: { original: d } }) =>
        isTestRow(d) ? (
          <span className="flex items-center gap-2 font-medium text-fg-strong">
            {EVENT_LABEL[d.type]}
            <StatusPill status="neutral">{TEST_TAG}</StatusPill>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => onOpen(d)}
            aria-label={label(d)}
            aria-current={selected === rowKey(d) ? 'true' : undefined}
            className="block max-w-full truncate rounded-sm text-left font-medium text-fg-strong underline-offset-2 wl-colors hover:text-accent-fg hover:underline focus-visible:outline-2 focus-visible:outline-focus aria-[current=true]:text-accent-fg"
          >
            {EVENT_LABEL[d.type]}
          </button>
        ),
    },
    ...(showEndpoint
      ? [
          {
            id: 'endpoint',
            header: 'Endpoint',
            meta: { nowrap: true },
            cell: ({ row: { original: d } }: { row: { original: DeliveryListRow } }) =>
              isTestRow(d) ? null : (
                <span className="font-mono text-xs text-fg-muted">{d.endpointName ?? '—'}</span>
              ),
          },
        ]
      : []),
    {
      id: 'pass',
      header: 'Pass',
      meta: { hideBelow: 'md', nowrap: true },
      cell: ({ row: { original: d } }) =>
        isTestRow(d) ? (
          <span className="text-fg-subtle">—</span>
        ) : (
          host.passLink(
            { passId: d.passId, externalId: d.externalId, label: passLabel(d) },
            'list',
          )
        ),
    },
    {
      id: 'state',
      header: 'Status',
      cell: ({ row: { original: d } }) =>
        isTestRow(d) ? (
          <StatusPill status={d.ok ? 'success' : 'danger'}>{d.ok ? 'Sent' : 'Failed'}</StatusPill>
        ) : (
          <span title={stateHint(d, d.endpointStatus ?? endpointStatus)}>
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
      cell: ({ row: { original: d } }) => (isTestRow(d) ? 1 : d.attempts),
    },
    {
      id: 'response',
      header: 'Response',
      meta: { nowrap: true, hideBelow: 'sm' },
      cell: ({ row: { original: d } }) =>
        isTestRow(d) ? (
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
    ...(host.canManage
      ? [
          {
            id: 'actions',
            header: 'Replay',
            meta: { nowrap: true },
            cell: ({ row: { original: d } }: { row: { original: DeliveryListRow } }) =>
              isTestRow(d) ? null : (
                <span
                  title={
                    d.state === 'pending' ? 'Pending deliveries cannot be replayed' : undefined
                  }
                >
                  <IconButton
                    label={`Replay ${EVENT_LABEL[d.type]} delivery`}
                    size="sm"
                    disabled={d.state === 'pending' || replaying === rowKey(d)}
                    icon={<RotateCw aria-hidden />}
                    onClick={() => onReplay(d)}
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
        isTestRow(d) ? (
          formatDateTime(d.at)
        ) : d.lastAttemptAt === null ? (
          <span className="text-fg-muted">Not sent</span>
        ) : (
          formatDateTime(d.lastAttemptAt)
        ),
    },
  ];
  const mode = filter?.value ?? 'all';
  return (
    <div className="flex flex-col gap-3">
      {filter ? (
        <SegmentedControl
          label="Show deliveries"
          options={FILTERS}
          value={filter.value}
          onValueChange={filter.onChange}
          className="self-start"
        />
      ) : null}
      {error && rows.length === 0 ? (
        <ErrorState error={error} {...(onRetry ? { onRetry } : {})} />
      ) : (
        <DataTable
          caption={caption}
          columns={columns}
          data={rows}
          getRowId={rowKey}
          loading={loading}
          fetching={Boolean(fetching)}
          bare
          empty={<EmptyState inline art="log" title={emptyTitle ?? EMPTY[mode]} />}
          footer={footer}
        />
      )}
    </div>
  );
}
