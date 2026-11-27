import type { Mode } from '../../../shared/contracts/common.ts';
import {
  LATEST_WEBHOOK_API_VERSION,
  WEBHOOK_MAX_BODY_BYTES,
  type WebhookApiVersion,
  type WebhookEvent,
  type WebhookEventType,
  WebhookEventTypeSchema,
} from '../../../shared/contracts/webhooks.ts';

/** One `event_feed` row. Fields the trigger copied from the ledger and its pass; `data` is raw JSON. */
export interface FeedRow {
  seq: number;
  eventId: string;
  orgId: string;
  mode: Mode;
  passId: string;
  templateId: string;
  externalId: string | null;
  type: string;
  kind: string;
  device: string | null;
  deviceCount: number | null;
  actorType: string | null;
  data: string;
  at: number;
}

/** The contract's string bound: a longer value is dropped so the event always parses. */
const MAX_STRING = 300;

type Data = Record<string, unknown>;
type Out = Record<string, string | number | boolean | null>;

function parse(raw: string): Data {
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Data) : {};
  } catch {
    return {};
  }
}

/** Copies a field only when it has the expected type; anything else is dropped, never coerced. */
function pick(
  d: Data,
  fields: Record<string, 'string' | 'number' | 'boolean'>,
  rename: Record<string, string> = {},
): Out {
  const out: Out = {};
  for (const [field, type] of Object.entries(fields)) {
    const v = d[rename[field] ?? field];
    if (type === 'string' && typeof v === 'string' && v.length > MAX_STRING) continue;
    if (typeof v === type || (type === 'string' && v === null)) out[field] = v as string;
  }
  return out;
}

const EXITS = new Set(['scan', 'desk', 'stay', 'clear', 'zone', 'forced']);
const VERSION = { version: 'number' } as const;
const DEVICE_PASS = { devicePass: 'boolean', devicePassId: 'string' } as const;
const SCAN_IDS = { scanId: 'string', scannerId: 'string', staffId: 'string' } as const;

/**
 * The allowlist, per type. Only fields named here leave the platform; whatever else the ledger holds
 * (outbox ids, approvers, API key ids, before/after values) is dropped. Nothing is derived from a
 * holder, personalization or a raw device id.
 */
function dataOf(row: FeedRow, type: WebhookEventType): Out {
  const d = parse(row.data);
  switch (type) {
    case 'pass.issued':
      return pick(d, { ...VERSION, source: 'string' });
    case 'pass.updated':
      return pick(d, { ...VERSION, cause: 'string', source: 'string', notified: 'boolean' });
    case 'pass.voided':
    case 'pass.unvoided':
      return { actorType: row.actorType, ...pick(d, { runId: 'string' }) };
    case 'pass.removed':
      return pick(d, { ...VERSION, message: 'boolean', runId: 'string' });
    case 'pass.restored':
      return pick(d, VERSION);
    case 'pass.installed':
      return {
        wallet: 'apple',
        device: row.device,
        deviceCount: row.deviceCount ?? 0,
        firstDevice: row.deviceCount === 1,
        ...pick(d, DEVICE_PASS),
      };
    case 'pass.uninstalled': {
      const count = row.deviceCount ?? 0;
      return {
        wallet: 'apple',
        device: row.device,
        deviceCount: count,
        lastDevice: count === 0,
        cause: d.reason === 'push_gone' ? 'push_gone' : 'wallet',
        ...pick(d, DEVICE_PASS),
      };
    }
    case 'pass.scanned': {
      const out = pick(
        d,
        {
          scanId: 'string',
          action: 'string',
          method: 'string',
          scannerId: 'string',
          staffId: 'string',
          eventId: 'string',
          override: 'boolean',
          offline: 'boolean',
          amount: 'number',
        },
        { action: 'actionKind' },
      );
      out.outcome = row.kind === 'scan.heads_up' ? 'heads_up' : 'ok';
      if (d.direction === 'in' || d.direction === 'out') out.direction = d.direction;
      else if (row.kind === 'scan.checked_out') out.direction = 'out';
      if (typeof d.zoneId === 'string' && d.zoneId.length <= MAX_STRING) out.zoneId = d.zoneId;
      if (out.direction === 'out' && typeof d.exit === 'string' && EXITS.has(d.exit))
        out.exit = d.exit;
      return out;
    }
    case 'pass.scan_refused':
      return pick(d, {
        ...SCAN_IDS,
        reason: 'string',
        method: 'string',
        eventId: 'string',
      });
    case 'pass.scan_undone':
      return pick(d, SCAN_IDS);
    case 'pass.channels_changed':
      return pick(d, { channel: 'string', from: 'string', to: 'string', source: 'string' });
    case 'pass.printed':
      return pick(d, { printId: 'string', generation: 'number', voided: 'number' });
    case 'pass.print_voided':
      return pick(d, { printId: 'string', cause: 'string' });
    case 'pass.replaced':
      return pick(d, { replacedBy: 'string' });
    case 'push.failed':
      return pick(d, {
        ...VERSION,
        status: 'number',
        reason: 'string',
        code: 'string',
        ...DEVICE_PASS,
      });
    case 'email.failed':
      return pick(d, { code: 'string' });
    case 'webhook.test':
      return {};
  }
}

/** Set by the Workbench simulator; real events carry no flag. */
function simulatedOf(raw: string): { simulated?: true } {
  return parse(raw).simulated === true ? { simulated: true } : {};
}

/** The API request that caused the event, when the ledger kept it. */
function requestIdOf(raw: string): { requestId?: string } {
  const id = parse(raw).requestId;
  return typeof id === 'string' && id.length > 0 && id.length <= 64 ? { requestId: id } : {};
}

/**
 * The webhook and feed envelope for one journal row. Pure: the same row and version always give the
 * same event, so a replay is identical but for its timestamp and signature.
 */
export function buildEnvelope(
  row: FeedRow,
  apiVersion: WebhookApiVersion = LATEST_WEBHOOK_API_VERSION,
  sample = false,
): WebhookEvent {
  const type = WebhookEventTypeSchema.parse(row.type);
  return {
    id: row.eventId,
    type,
    apiVersion,
    createdAt: row.at,
    orgId: row.orgId,
    mode: row.mode,
    pass: { id: row.passId, externalId: row.externalId, templateId: row.templateId },
    data: dataOf(row, type),
    ...requestIdOf(row.data),
    ...simulatedOf(row.data),
    ...(sample ? { sample: true } : {}),
  } as WebhookEvent;
}

/** The event a "Send test" posts. It describes no pass. */
export function testEnvelope(input: {
  id: string;
  orgId: string;
  mode: Mode;
  now: number;
  apiVersion?: WebhookApiVersion;
}): WebhookEvent {
  return {
    id: input.id,
    type: 'webhook.test',
    apiVersion: input.apiVersion ?? LATEST_WEBHOOK_API_VERSION,
    createdAt: input.now,
    orgId: input.orgId,
    mode: input.mode,
    pass: null,
    data: {},
  };
}

/** The request body. The ledger caps `data` at 2 KB, so an envelope past 8 KB is a bug, not input. */
export function bodyOf(event: WebhookEvent): string {
  const body = JSON.stringify(event);
  if (new TextEncoder().encode(body).length > WEBHOOK_MAX_BODY_BYTES)
    throw new RangeError('WEBHOOK_PAYLOAD_TOO_LARGE');
  return body;
}
