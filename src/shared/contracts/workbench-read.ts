import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.ts';
import { WebhookDeliverySchema } from './webhooks.ts';

const count = z.number().int().nonnegative();

/** A request id (a Cloudflare ray or a UUID) or the id of an object in the context. */
export const ResolveQuerySchema = z.object({
  // Hyphens only, except a device pass's `dp_`: a key's secret has underscores, so one pasted here is a 422.
  id: z.string().regex(/^(?:dp_[A-Za-z0-9-]{8,60}|[A-Za-z0-9-]{8,64})$/),
  orgId: IdSchema.optional().describe(
    'The organization to look in. Omit it for your own sandbox. An organization you may use Test in is allowed.',
  ),
});

export const RESOLVE_KINDS = [
  'request',
  'pass',
  'template',
  'sandbox',
  'key',
  'event',
  'delivery',
  'capture',
  'endpoint',
  'operation',
  'device_pass',
  'live',
  'org',
] as const;

export const ResolvedSchema = z.object({
  kind: z
    .enum(RESOLVE_KINDS)
    .describe(
      '`live`: the id exists in Live. Open it in admin. `org`: the older name of `sandbox`, still sent by `/developer/resolve`.',
    ),
  id: z.string().describe('The id as stored, which can differ in case from the one sent.'),
  label: z.string(),
  href: z
    .string()
    .describe(
      'Where it opens: a Workbench tool, the portal for the older kinds, or admin for `live`.',
    ),
});
export type Resolved = z.infer<typeof ResolvedSchema>;

const quota = z.object({ used: count, limit: count.nullable() });
/** A sandbox's caps against what it holds. `limit` is null when the plan sets none. */
export const QuotasSchema = z.object({
  passes: quota,
  templates: quota,
  endpoints: quota,
  keys: quota,
});
export type Quotas = z.infer<typeof QuotasSchema>;

const since = (what: string) =>
  z.coerce
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(`Ms timestamp: ${what} newer than it count. Omitted counts all that is kept.`);

/** The nav's attention counts. The seen marks are the client's, so each `since` is a plain timestamp. */
export const WorkbenchSummaryQuerySchema = z.object({
  orgId: IdSchema.optional().describe('Omit for your own sandbox.'),
  'since[logs]': since('errors'),
  'since[events]': since('failed deliveries'),
  'since[inbox]': since('emails'),
});

export const WorkbenchSummarySchema = z.object({
  now: TimestampSchema,
  quickstart: z
    .object({ done: count, total: count })
    .nullable()
    .describe('Sandbox only. Null in an organization.'),
  errors: count.describe(
    'Test calls with status 400 or more, newer than `since[logs]`. Capped at 99.',
  ),
  failedDeliveries: count.describe(
    'Test deliveries that failed, newer than `since[events]`. Capped at 99.',
  ),
  listening: z.boolean().describe('An active Test endpoint is attached.'),
  inboxNew: count.describe('Test emails newer than `since[inbox]`. Capped at 99.'),
  keysExpiring: count.describe('Test keys that expire within 7 days.'),
  quotas: QuotasSchema.nullable().describe('Sandbox only. Null in an organization.'),
});
export type WorkbenchSummary = z.infer<typeof WorkbenchSummarySchema>;

export const WORKBENCH_TOOLS = [
  'home',
  'design',
  'passes',
  'console',
  'logs',
  'events',
  'inbox',
  'activity',
  'keys',
] as const;
export const WorkbenchToolSchema = z.enum(WORKBENCH_TOOLS);

export const WorkbenchContextsSchema = z.object({
  sandbox: z
    .object({
      orgId: IdSchema,
      name: z.string(),
      slug: z.string(),
      closed: z.boolean(),
    })
    .nullable()
    .describe('Your developer sandbox, or null before you make one.'),
  orgs: z.array(
    z.object({
      orgId: IdSchema,
      name: z.string(),
      slug: z.string(),
      tools: z.array(WorkbenchToolSchema).describe('The tools your roles may read there.'),
    }),
  ),
});
export type WorkbenchContexts = z.infer<typeof WorkbenchContextsSchema>;

/** One delivery attempt chain of an event to one endpoint. */
export const EventDeliverySchema = WebhookDeliverySchema.extend({
  endpointId: IdSchema,
  target: z.enum(['url', 'capture']),
});
export const EventDeliveriesSchema = z.object({ items: z.array(EventDeliverySchema) });
export type EventDeliveries = z.infer<typeof EventDeliveriesSchema>;
