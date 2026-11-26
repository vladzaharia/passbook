import { RotateCw } from 'lucide-react';
import { WEBHOOK_USER_AGENT, type WebhookEndpointStatus } from '@/shared/contracts/webhooks.ts';
import { formatDateTime } from '../../lib/format.ts';
import {
  Button,
  Callout,
  CodeBlock,
  ErrorState,
  JsonViewer,
  KeyValue,
  Skeleton,
  StatusPill,
  Timeline,
  type TimelineItem,
} from '../index.ts';
import type { DeliveryDetail, DeliveryHost, DeliveryRead } from './delivery-types.ts';
import {
  DELIVERY_STATE_LABEL,
  DELIVERY_STATUS,
  EVENT_LABEL,
  failureLabel,
  passLabel,
  TRIGGER_LABEL,
} from './labels.ts';
import { VerifyGuide } from './verify-guide.tsx';

export interface DeliveryInspectorProps {
  host: DeliveryHost;
  read: DeliveryRead;
  /** Why a delivery that never went out is waiting. */
  endpointStatus: WebhookEndpointStatus;
  onReplay: () => void;
  replaying: boolean;
  /** A refusal of the last replay, in words. */
  error?: string | undefined;
  /** The request section belongs to the capture beside it. */
  hideRequest?: boolean;
}

/**
 * One delivery: what happened on each attempt and the exact payload (an allowlist, no holder data,
 * so it is safe to show). Replay sends the same event id and body again. Admin draws it in a sheet
 * and the Workbench inside an event; the body is the same.
 */
export function DeliveryInspector({
  host,
  read,
  endpointStatus,
  onReplay,
  replaying,
  error,
  hideRequest,
}: DeliveryInspectorProps) {
  const d = read.data;
  if (read.isPending)
    return (
      <div role="status" aria-label="Loading delivery" className="flex flex-col gap-3">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  if (read.isError || !d) return <ErrorState error={read.error} onRetry={read.refetch} />;
  const attempts: TimelineItem[] = d.attemptLog.map((a) => {
    const ok = a.status !== null && a.status >= 200 && a.status < 300;
    return {
      id: String(a.attempt),
      title: `${TRIGGER_LABEL[a.trigger]}: ${ok ? `HTTP ${a.status}` : failureLabel(a.status, a.errorCode)}`,
      time: a.at,
      description: `${a.durationMs} ms${ok ? '' : ', no usable response'}`,
      tone: ok ? 'success' : 'danger',
    };
  });
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status={DELIVERY_STATUS[d.state]}>{DELIVERY_STATE_LABEL[d.state]}</StatusPill>
        <span className="text-sm font-medium text-fg-strong">{EVENT_LABEL[d.type]}</span>
      </div>
      <StateNote d={d} endpointStatus={endpointStatus} />
      <KeyValue
        items={[
          { label: 'Event time', value: formatDateTime(d.payload.createdAt) },
          {
            label: 'Pass',
            value: host.passLink(
              { passId: d.passId, externalId: d.externalId, label: passLabel(d) },
              'inspector',
            ),
          },
          { label: 'Event id', value: d.eventId, mono: true, copy: true },
          { label: 'Attempts', value: String(d.attempts) },
          { label: 'Replays', value: String(d.replays) },
          {
            label: d.state === 'pending' ? 'Next attempt' : 'Finished',
            value: formatDateTime(d.state === 'pending' ? d.nextAt : d.finishedAt, '—'),
          },
        ]}
      />
      {error ? <Callout tone="danger">{error}</Callout> : null}
      {host.canManage ? (
        <Button
          variant="outline"
          className="self-start"
          busy="spin"
          loading={replaying}
          disabled={d.state === 'pending'}
          iconStart={<RotateCw aria-hidden />}
          onClick={onReplay}
        >
          Replay
        </Button>
      ) : null}
      {host.canManage && d.state === 'pending' ? (
        <p className="-mt-3 text-xs text-fg-muted">
          A pending delivery is already queued. Replay it once it finishes.
        </p>
      ) : null}
      <div>
        <h3 className="mb-3 text-sm font-semibold text-fg-strong">Attempts</h3>
        {attempts.length === 0 ? (
          <p className="text-sm text-fg-muted">No attempts yet.</p>
        ) : (
          <>
            <Timeline items={attempts} />
            <p className="mt-3 text-xs text-fg-muted">
              Response bodies are not stored. Status and time are.
            </p>
          </>
        )}
      </div>
      {hideRequest ? null : (
        <div>
          <h3 className="mb-3 text-sm font-semibold text-fg-strong">Request</h3>
          <CodeBlock code={requestText(d)} label="Request headers" maxHeight="max-h-48" wrap />
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-fg-muted pointer-coarse:min-h-11">
              Copy as curl
            </summary>
            <p className="py-2 text-xs text-fg-muted">
              Signs the body with your secret and posts it to the URL you set. Nothing is sent to
              PassBook.
            </p>
            <CodeBlock code={curlText(d)} label="curl command" maxHeight="max-h-48" wrap />
          </details>
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-fg-muted pointer-coarse:min-h-11">
              How to verify the signature
            </summary>
            <VerifyGuide className="pt-3" />
          </details>
        </div>
      )}
      <div>
        <h3 className="mb-3 text-sm font-semibold text-fg-strong">Payload</h3>
        <JsonViewer value={d.payload} label="Payload JSON" maxHeight="max-h-80" />
      </div>
    </div>
  );
}

/** What the delivery is doing and what to do about it, in one line. */
function StateNote({
  d,
  endpointStatus,
}: {
  d: DeliveryDetail;
  endpointStatus: WebhookEndpointStatus;
}) {
  const last = failureLabel(d.lastStatus, d.lastError);
  if (d.state === 'pending') {
    if (endpointStatus !== 'active')
      return (
        <Callout title="Not sent">
          {endpointStatus === 'paused'
            ? 'The endpoint is paused. Resume it to send this.'
            : 'The endpoint is disabled. Fix it and resume to send this.'}
        </Callout>
      );
    return d.attempts === 0 ? (
      <Callout title="Not sent yet">Waiting in the queue. It goes out within a minute.</Callout>
    ) : (
      <Callout tone="warning" title="Retrying">
        {`Last result: ${last}. Next attempt ${formatDateTime(d.nextAt)}. PassBook retries for up to 3 days.`}
      </Callout>
    );
  }
  if (d.state === 'failed')
    return (
      <Callout tone="danger" title="Failed">
        {`Last result: ${last}. Fix the endpoint, then replay.`}
      </Callout>
    );
  if (d.state === 'cancelled')
    return (
      <Callout title="Cancelled">{`${last || 'No longer sent'}. Replay to send it again.`}</Callout>
    );
  return null;
}

/** The headers of the latest attempt. The timestamp is that attempt's, the signature is re-made each time. */
function requestText(d: DeliveryDetail): string {
  const at = d.attemptLog.at(-1)?.at;
  return [
    'POST <endpoint URL>',
    'content-type: application/json',
    `user-agent: ${WEBHOOK_USER_AGENT}`,
    `x-passbook-event-id: ${d.eventId}`,
    `x-passbook-event-type: ${d.type}`,
    `x-passbook-timestamp: ${at === undefined ? '<unix seconds>' : Math.floor(at / 1000)}`,
    'x-passbook-signature: v1=<hex>',
  ].join('\n');
}

const shq = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/** A script that re-sends this event to a receiver under test: the same headers, signed fresh. */
function curlText(d: DeliveryDetail): string {
  return [
    '# Set ENDPOINT_URL and SECRET (the signing secret) first.',
    'TS=$(date +%s)',
    `BODY=${shq(JSON.stringify(d.payload))}`,
    'SIG=$(printf \'%s.%s\' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed \'s/^.* //\')',
    'curl -X POST "$ENDPOINT_URL" \\',
    "  -H 'content-type: application/json' \\",
    `  -H ${shq(`x-passbook-event-id: ${d.eventId}`)} \\`,
    `  -H ${shq(`x-passbook-event-type: ${d.type}`)} \\`,
    '  -H "x-passbook-timestamp: $TS" \\',
    '  -H "x-passbook-signature: v1=$SIG" \\',
    '  --data-raw "$BODY"',
  ].join('\n');
}
