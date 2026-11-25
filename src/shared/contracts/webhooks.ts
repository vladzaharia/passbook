import { z } from 'zod';
import { ChannelSchema, ChannelSourceSchema } from './channels.ts';
import {
  IdSchema,
  ModeSchema,
  PageQuerySchema,
  PlainLineSchema,
  pageOf,
  TimestampSchema,
} from './common.ts';

/** Closed list: a new type is added here, with its data schema, label and group. */
export const WEBHOOK_EVENT_TYPES = [
  'pass.issued',
  'pass.updated',
  'pass.voided',
  'pass.unvoided',
  'pass.removed',
  'pass.restored',
  'pass.installed',
  'pass.uninstalled',
  'pass.scanned',
  'pass.scan_refused',
  'pass.scan_undone',
  'pass.channels_changed',
  'pass.printed',
  'pass.print_voided',
  'push.failed',
  'email.failed',
  'webhook.test',
] as const;
export const WebhookEventTypeSchema = z.enum(WEBHOOK_EVENT_TYPES);
export type WebhookEventType = z.infer<typeof WebhookEventTypeSchema>;

/** What an endpoint may subscribe to: every type but the test event, which is sent on request. */
export const SUBSCRIBABLE_EVENT_TYPES = WEBHOOK_EVENT_TYPES.filter(
  (t): t is Exclude<WebhookEventType, 'webhook.test'> => t !== 'webhook.test',
);
export const SubscribableEventTypeSchema = z.enum(
  SUBSCRIBABLE_EVENT_TYPES as [
    Exclude<WebhookEventType, 'webhook.test'>,
    ...Exclude<WebhookEventType, 'webhook.test'>[],
  ],
);

/** Additive changes need no new version; a rename, removal or change of meaning does. */
/** Oldest first. `2026-12-01` was stamped before it matched a changelog date; endpoints that carry it keep it. */
export const WEBHOOK_API_VERSIONS = ['2026-12-01', '2026-11-20'] as const;
export const WebhookApiVersionSchema = z.enum(WEBHOOK_API_VERSIONS);
export type WebhookApiVersion = z.infer<typeof WebhookApiVersionSchema>;
export const LATEST_WEBHOOK_API_VERSION: WebhookApiVersion = '2026-11-20';

export const WEBHOOK_ENDPOINT_LIMIT = 10;
export const WEBHOOK_MAX_TEMPLATES = 20;
export const WEBHOOK_MAX_BODY_BYTES = 8192;

const Version = z.number().int().nonnegative();
const Str = z.string().max(300);
const Wallet = z.literal('apple');
const RunId = Str.optional();
const Flag = z.boolean().optional();

/**
 * The `data` of each type is an allowlist: receivers must ignore unknown fields, and nothing about
 * a holder (name, email, personalization, raw device id, push token, code or URL) is ever in it.
 */
export const WEBHOOK_DATA_SCHEMAS = {
  'pass.issued': z.object({ version: Version.optional(), source: Str.nullable().optional() }),
  'pass.updated': z.object({
    version: Version.optional(),
    cause: Str.nullable().optional(),
    source: Str.nullable().optional(),
    notified: z.boolean().optional(),
  }),
  'pass.voided': z.object({ actorType: Str.nullable().optional(), runId: RunId }),
  'pass.unvoided': z.object({ actorType: Str.nullable().optional() }),
  'pass.removed': z.object({ version: Version.optional(), message: Flag, runId: RunId }),
  'pass.restored': z.object({ version: Version.optional() }),
  'pass.installed': z.object({
    wallet: Wallet,
    device: z.string().max(12).nullable(),
    deviceCount: Version,
    firstDevice: z.boolean(),
  }),
  'pass.uninstalled': z.object({
    wallet: Wallet,
    device: z.string().max(12).nullable(),
    deviceCount: Version,
    lastDevice: z.boolean(),
    cause: z.enum(['wallet', 'push_gone']),
  }),
  'pass.scanned': z.object({
    scanId: Str.nullable().optional(),
    action: Str.nullable().optional(),
    outcome: z.enum(['ok', 'heads_up']),
    direction: z.enum(['in', 'out']).optional(),
    method: Str.nullable().optional(),
    scannerId: Str.nullable().optional(),
    staffId: Str.nullable().optional(),
    eventId: Str.nullable().optional(),
    override: z.boolean().optional(),
    offline: z.boolean().optional(),
    amount: z.number().optional(),
  }),
  'pass.scan_refused': z.object({
    scanId: Str.nullable().optional(),
    reason: Str.nullable().optional(),
    method: Str.nullable().optional(),
    scannerId: Str.nullable().optional(),
    staffId: Str.nullable().optional(),
    eventId: Str.nullable().optional(),
  }),
  'pass.scan_undone': z.object({
    scanId: Str.nullable().optional(),
    scannerId: Str.nullable().optional(),
    staffId: Str.nullable().optional(),
  }),
  'pass.channels_changed': z.object({
    channel: ChannelSchema,
    from: z.enum(['on', 'off']),
    to: z.enum(['on', 'off']),
    source: ChannelSourceSchema,
  }),
  'pass.printed': z.object({
    printId: Str,
    generation: Version,
    /** Earlier prints this one voided. */
    voided: Version.optional(),
  }),
  'pass.print_voided': z.object({ printId: Str, cause: Str.nullable().optional() }),
  'push.failed': z.object({
    version: Version.optional(),
    status: z.number().int().optional(),
    reason: Str.nullable().optional(),
    code: Str.nullable().optional(),
  }),
  'email.failed': z.object({ code: Str.nullable().optional() }),
  'webhook.test': z.object({}),
} as const satisfies Record<WebhookEventType, z.ZodType>;

export const WebhookPassRefSchema = z.object({
  id: IdSchema,
  externalId: z.string().nullable(),
  templateId: IdSchema,
});

const envelope = <T extends WebhookEventType, P extends z.ZodType>(type: T, pass: P) =>
  z.object({
    id: IdSchema,
    type: z.literal(type),
    apiVersion: WebhookApiVersionSchema,
    createdAt: TimestampSchema,
    orgId: IdSchema,
    mode: ModeSchema,
    pass,
    data: WEBHOOK_DATA_SCHEMAS[type],
    /** Only on a sample sent from "Send test": it describes no real pass. */
    sample: z.literal(true).optional(),
  });

const P = WebhookPassRefSchema;
/** `pass` is null only for `webhook.test`. */
export const WebhookEventSchema = z.discriminatedUnion('type', [
  envelope('pass.issued', P),
  envelope('pass.updated', P),
  envelope('pass.voided', P),
  envelope('pass.unvoided', P),
  envelope('pass.removed', P),
  envelope('pass.restored', P),
  envelope('pass.installed', P),
  envelope('pass.uninstalled', P),
  envelope('pass.scanned', P),
  envelope('pass.scan_refused', P),
  envelope('pass.scan_undone', P),
  envelope('pass.channels_changed', P),
  envelope('pass.printed', P),
  envelope('pass.print_voided', P),
  envelope('push.failed', P),
  envelope('email.failed', P),
  envelope('webhook.test', z.null()),
]);
export type WebhookEvent = z.infer<typeof WebhookEventSchema>;

export const WebhookEndpointStatusSchema = z.enum(['active', 'paused', 'disabled']);
export type WebhookEndpointStatus = z.infer<typeof WebhookEndpointStatusSchema>;

export const WebhookEndpointSchema = z.object({
  id: IdSchema,
  orgId: IdSchema,
  mode: ModeSchema,
  /** The full URL is a capability: null for a reader (`integrations:read`). */
  url: z.string().nullable(),
  /** The host, then `/…` when there is a path: the path is a bearer secret. */
  urlMasked: z.string(),
  description: z.string(),
  eventTypes: z.array(SubscribableEventTypeSchema),
  templateIds: z.array(IdSchema).nullable(),
  apiVersion: WebhookApiVersionSchema,
  status: WebhookEndpointStatusSchema,
  /** `capture` stores the signed request instead of sending it (developer orgs, Test). */
  target: z.enum(['url', 'capture']),
  failingSince: TimestampSchema.nullable(),
  disabledAt: TimestampSchema.nullable(),
  lastSuccessAt: TimestampSchema.nullable(),
  lastFailureAt: TimestampSchema.nullable(),
  /** HTTP status of the newest attempted delivery; null when none yet or no response. */
  lastStatus: z.number().int().nullable(),
  /** The signing secret itself is never returned after creation or rotation. */
  secretCreatedAt: TimestampSchema.nullable(),
  /** A rotated secret that still signs until this time; null when none was rotated. */
  previousSecretExpiresAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});
export type WebhookEndpointDto = z.infer<typeof WebhookEndpointSchema>;

const EventTypeList = z.array(SubscribableEventTypeSchema).min(1).max(32);
const TemplateIdList = z.array(IdSchema).min(1).max(WEBHOOK_MAX_TEMPLATES);

/** The mode is never in the body: it comes from the caller's authority. */
export const CreateWebhookEndpointSchema = z.object({
  /** A platform key names the org it acts on. */
  orgId: IdSchema.optional(),
  url: z.string().trim().min(1).max(2048),
  description: PlainLineSchema(120).optional(),
  eventTypes: EventTypeList,
  templateIds: TemplateIdList.nullable().optional(),
});

export const UpdateWebhookEndpointSchema = z.object({
  url: z.string().trim().min(1).max(2048).optional(),
  /** An empty string clears it. */
  description: z.union([z.literal(''), PlainLineSchema(120)]).optional(),
  eventTypes: EventTypeList.optional(),
  templateIds: TemplateIdList.nullable().optional(),
  status: z.enum(['active', 'paused']).optional(),
  apiVersion: WebhookApiVersionSchema.optional(),
});

/** Sent on every request; the delivery sheet shows it. */
export const WEBHOOK_USER_AGENT = 'PassBook-Webhooks/1.0';

export const WebhookSecretSchema = z.object({ secret: z.string() });
export const WebhookEndpointListSchema = pageOf(WebhookEndpointSchema);
export const WebhookEndpointCreatedSchema = z.object({
  endpoint: WebhookEndpointSchema,
  secret: z.string(),
});

export const WebhookTestResultSchema = z.object({
  ok: z.boolean(),
  status: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
  /** The stored capture, for a capture endpoint. */
  captureId: IdSchema.nullable(),
});

export const WebhookDeliveryStateSchema = z.enum(['pending', 'delivered', 'failed', 'cancelled']);
export const WebhookDeliverySchema = z.object({
  eventId: IdSchema,
  type: WebhookEventTypeSchema,
  passId: IdSchema,
  externalId: z.string().nullable(),
  state: WebhookDeliveryStateSchema,
  attempts: z.number().int().nonnegative(),
  nextAt: TimestampSchema,
  lastStatus: z.number().int().nullable(),
  lastError: z.string().nullable(),
  lastAttemptAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(),
  replays: z.number().int().nonnegative(),
});
export const WebhookDeliveryListSchema = pageOf(WebhookDeliverySchema);

export const WebhookAttemptSchema = z.object({
  attempt: z.number().int().positive(),
  trigger: z.enum(['event', 'retry', 'replay', 'test']),
  status: z.number().int().nullable(),
  errorCode: z.string().nullable(),
  durationMs: z.number().int().nonnegative(),
  at: TimestampSchema,
});
export const WebhookDeliveryDetailSchema = WebhookDeliverySchema.extend({
  attemptLog: z.array(WebhookAttemptSchema),
  payload: WebhookEventSchema,
});

export const WebhookDeliveryListQuerySchema = PageQuerySchema.extend({
  state: WebhookDeliveryStateSchema.optional(),
  type: WebhookEventTypeSchema.optional(),
});

export const WebhookReplaySchema = z
  .object({
    from: TimestampSchema,
    to: TimestampSchema,
    include: z.enum(['failed', 'failed_and_cancelled', 'all']).default('failed'),
    /** Also create deliveries for feed events the endpoint never had. */
    missing: z.boolean().optional(),
    /** Count what would be sent and change nothing. */
    dryRun: z.boolean().optional(),
  })
  .refine((r) => r.from <= r.to, { message: 'from must not be after to', path: ['from'] });
export const WebhookReplayResultSchema = z.object({ queued: z.number().int().nonnegative() });

/** `ev2.<22 chars>` (opaque), the older `ev1.<n>` (accepted for one more release), or `now` for the head. */
export const EVENT_FEED_CURSOR = /^(?:now|ev1\.(?:0|[1-9]\d{0,14})|ev2\.[A-Za-z0-9_-]{22})$/;

export const EventFeedQuerySchema = z.object({
  orgId: IdSchema.optional(),
  after: z.string().regex(EVENT_FEED_CURSOR).optional(),
  types: z
    .string()
    .max(600)
    .transform((s) => s.split(',').filter(Boolean))
    .pipe(z.array(SubscribableEventTypeSchema).min(1).max(32))
    .optional(),
  passId: IdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  apiVersion: WebhookApiVersionSchema.optional(),
});
export const EventFeedPageSchema = z.object({
  items: z.array(WebhookEventSchema),
  /** Never null: the last item's cursor, or the input cursor on an empty page. */
  nextCursor: z.string(),
  hasMore: z.boolean(),
});
