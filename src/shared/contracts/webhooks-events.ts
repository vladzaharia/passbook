import { z } from 'zod';
import { ChannelSchema, ChannelSourceSchema } from './channels.ts';
import { IdSchema, ModeSchema, TimestampSchema } from './common.ts';

/** Closed list: a new type is added here, with its data schema, label and group. */
export const WEBHOOK_EVENT_TYPES = [
  'pass.issued',
  'pass.updated',
  'pass.voided',
  'pass.unvoided',
  'pass.removed',
  'pass.restored',
  'pass.replaced',
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
const Opt = Str.nullable().optional();
const Flag = z.boolean().optional();
/** On an event about a developer's own device pass: a Test pass on their phone (Workbench), not a real holder. */
const DevicePass = { devicePass: Flag, devicePassId: Str.optional() };

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
    ...DevicePass,
  }),
  'pass.uninstalled': z.object({
    wallet: Wallet,
    device: z.string().max(12).nullable(),
    deviceCount: Version,
    lastDevice: z.boolean(),
    cause: z.enum(['wallet', 'push_gone']),
    ...DevicePass,
  }),
  'pass.scanned': z.object({
    scanId: Str.nullable().optional(),
    action: Str.nullable().optional(),
    outcome: z.enum(['ok', 'heads_up']),
    direction: z.enum(['in', 'out']).optional(),
    zoneId: Opt,
    /** On direction `out`: `scan` for an exit tap, else how the stay ended. */
    exit: z.enum(['scan', 'desk', 'stay', 'clear', 'zone', 'forced']).optional(),
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
  'pass.scan_undone': z.object({ scanId: Opt, scannerId: Opt, staffId: Opt }),
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
  /** The pass was replaced by another on a new signing identity; `replacedBy` is its id. */
  'pass.replaced': z.object({ replacedBy: Str }),
  'push.failed': z.object({
    version: Version.optional(),
    status: z.number().int().optional(),
    reason: Str.nullable().optional(),
    code: Str.nullable().optional(),
    ...DevicePass,
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
    /** The id of the API request that caused the event (the `x-request-id` it answered with); absent when no request did. */
    requestId: z.string().optional(),
    /** Only on a sample sent from "Send test": it describes no real pass. */
    sample: z.literal(true).optional(),
    /** Present, true, only on an event the Workbench simulator sent. */
    simulated: z.literal(true).optional(),
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
  envelope('pass.replaced', P),
  envelope('push.failed', P),
  envelope('email.failed', P),
  envelope('webhook.test', z.null()),
]);
export type WebhookEvent = z.infer<typeof WebhookEventSchema>;
