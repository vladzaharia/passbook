import type { WebhookCaptureDto } from '../../../shared/contracts/webhook-captures.ts';
import type { WebhookEndpointDto } from '../../../shared/contracts/webhooks.ts';
import { BENCH_WEBHOOKS_COPY } from '../../../shared/copy/developers-bench-webhooks.ts';
import { testRowOf } from '../../../shared/webhook-test-rows.ts';
import type { StatusTone } from '../bench/status-chip.tsx';
import { toneOfState, toneOfStatus } from '../bench/status-chip.tsx';
import type { DeliveryDto, TestAttemptDto } from './client.ts';

const C = BENCH_WEBHOOKS_COPY;

/** One line of the list: a capture, a URL delivery or a test send, as the same kind of row. */
export interface Row {
  /** Capture id, event id (a URL delivery) or test id: what `#id` selects. */
  id: string;
  kind: 'capture' | 'delivery' | 'test';
  endpointId: string;
  at: number;
  type: string;
  /** The answer, null when there was none (yet). */
  status: number | null;
  /** A delivery's state; a capture or test is `delivered` or `failed` by its answer. */
  state: DeliveryDto['state'];
  eventId: string | null;
  /** The API request that caused it, when the payload says (a capture carries it; a delivery reads it on open). */
  requestId: string | null;
  passId: string | null;
  /** The line under the type. */
  meta: string;
  durationMs: number | null;
  capture?: WebhookCaptureDto;
}

interface Payload {
  requestId?: unknown;
  pass?: { id?: unknown; externalId?: unknown } | null;
}

/** The request and pass a capture's body names; a broken body names none. */
export function factsOfBody(body: string): {
  requestId: string | null;
  passId: string | null;
  externalId: string | null;
} {
  let p: Payload = {};
  try {
    p = JSON.parse(body) as Payload;
  } catch {
    // A capture is always our own JSON; a broken one just has nothing to link.
  }
  const text = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return {
    requestId: text(p.requestId),
    passId: text(p.pass?.id),
    externalId: text(p.pass?.externalId),
  };
}

export function captureRow(c: WebhookCaptureDto): Row {
  const f = factsOfBody(c.body);
  const trigger =
    c.trigger === 'event' && f.externalId ? f.externalId : C.inspector.trigger[c.trigger];
  return {
    id: c.id,
    kind: 'capture',
    endpointId: c.endpointId,
    at: c.createdAt,
    type: c.type,
    status: c.status,
    state: c.status >= 200 && c.status < 300 ? 'delivered' : 'failed',
    eventId: c.eventId,
    requestId: f.requestId,
    passId: f.passId,
    meta: trigger,
    durationMs: c.durationMs,
    capture: c,
  };
}

export function deliveryRow(d: DeliveryDto, endpointId: string): Row {
  return {
    id: d.eventId,
    kind: 'delivery',
    endpointId,
    at: d.lastAttemptAt ?? d.nextAt,
    type: d.type,
    status: d.lastStatus,
    state: d.state,
    eventId: d.eventId,
    requestId: null,
    passId: d.passId,
    meta: [d.lastError, d.externalId].filter(Boolean).join(' · '),
    durationMs: null,
  };
}

export function testRow(t: TestAttemptDto, endpointId: string): Row {
  const r = testRowOf(t);
  return {
    id: r.key,
    kind: 'test',
    endpointId,
    at: r.at,
    type: r.type,
    status: r.status,
    state: r.ok ? 'delivered' : 'failed',
    eventId: null,
    requestId: null,
    passId: null,
    meta: r.detail,
    durationMs: t.durationMs,
  };
}

/** Newest first. */
export const byNewest = (rows: readonly Row[]): Row[] => [...rows].sort((a, b) => b.at - a.at);

const STATE_WORD: Record<DeliveryDto['state'], string> = {
  delivered: 'Delivered',
  failed: 'Failed',
  pending: 'Pending',
  cancelled: 'Cancelled',
};

/** What a row with no HTTP answer says instead of a number. */
export const stateWord = (r: Row): string => STATE_WORD[r.state];

export const toneOfRow = (r: Row): StatusTone =>
  r.status ? toneOfStatus(r.status) : toneOfState(r.state);

export type StatusFilter = 'ok' | 'failed' | 'pending';

const matchesStatus = (r: Row, f: string | undefined) => {
  if (f === 'ok') return r.state === 'delivered';
  if (f === 'failed') return r.state === 'failed' || r.state === 'cancelled';
  if (f === 'pending') return r.state === 'pending';
  return true;
};

/** The filters the server does not apply to a URL endpoint's deliveries: type and status. */
export function narrow(
  rows: readonly Row[],
  f: { type?: string | undefined; status?: string | undefined },
): Row[] {
  return rows.filter((r) => (!f.type || r.type === f.type) && matchesStatus(r, f.status));
}

/** The words of an endpoint in a select and in the Manage sheet. */
export const endpointLabel = (e: WebhookEndpointDto): string =>
  e.target === 'capture' ? C.capture.name : e.description || e.urlMasked;

/** The row `#id` names: its own id, or the event id of a capture (a Trace link names the event). */
export const findRow = (rows: readonly Row[], id: string): Row | undefined =>
  rows.find((r) => r.id === id) ?? rows.find((r) => r.eventId === id);
