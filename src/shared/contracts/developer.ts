import { z } from 'zod';
import {
  ApiScopeSchema,
  IdSchema,
  ModeSchema,
  OrgIdSchema,
  pageOf,
  TimestampSchema,
} from './common.ts';

/**
 * `POST /developer/sandbox` and `/recreate`: the Turnstile token of the widget with action `developer_sandbox`.
 * Both answer 202 with an operation (`kind` `sandbox.create`, `sandbox.recreate`); follow it at `/operations/{id}`.
 */
export const CreateDeveloperSandboxSchema = z.object({
  turnstileToken: z.string().min(1).max(4096),
  /** When this browser session first opened the quickstart (ms). The server clamps it to the last 24 hours. */
  viewedAt: TimestampSchema.optional(),
});
export type CreateDeveloperSandbox = z.infer<typeof CreateDeveloperSandboxSchema>;

/** The sandbox of the signed-in person. Every pass in it is a preview: none is signed, added to a wallet or pushed. */
export const DeveloperSandboxSchema = z.object({
  id: IdSchema,
  orgId: OrgIdSchema,
  orgSlug: z.string(),
  /** The ticket template made for the quickstart, released in Test. */
  templateId: IdSchema.nullable(),
  previewOnly: z.literal(true),
  createdAt: TimestampSchema,
  closedAt: TimestampSchema.nullable(),
  /** The org's IANA time zone, America/Los_Angeles when it has none: show times in it, never UTC. */
  timeZone: z.string(),
});
export type DeveloperSandbox = z.infer<typeof DeveloperSandboxSchema>;

/** A test key and its secret, shown once. */
export const SandboxKeySchema = z.object({
  id: IdSchema,
  name: z.string(),
  secret: z.string(),
  mode: z.literal('test'),
  expiresAt: TimestampSchema,
});
export type SandboxKey = z.infer<typeof SandboxKeySchema>;

/**
 * The reopen response: the sandbox and its new test key, whose secret is shown once. `previousKey` names a key
 * that already exists when there is none to show.
 */
export const CreatedDeveloperSandboxSchema = DeveloperSandboxSchema.extend({
  key: SandboxKeySchema.nullable(),
  previousKey: z.object({ id: IdSchema, name: z.string() }).nullable(),
});
export type CreatedDeveloperSandbox = z.infer<typeof CreatedDeveloperSandboxSchema>;

/**
 * `POST /developer/sandbox/key`: the sandbox's key, once. Making, resetting or starting over a sandbox ends
 * without a secret (an operation never holds one); this call mints it. A second call answers
 * 409 `SANDBOX_KEY_SHOWN` while the key is live: roll it.
 */
export const SandboxKeyResponseSchema = z.object({ key: SandboxKeySchema });
export type SandboxKeyResponse = z.infer<typeof SandboxKeyResponseSchema>;

/** `POST /developer/sandbox/reset`: the same check as making a sandbox. */
export const ResetDeveloperSandboxSchema = z.object({
  turnstileToken: z.string().min(1).max(4096),
});
export type ResetDeveloperSandbox = z.infer<typeof ResetDeveloperSandboxSchema>;

/**
 * `POST /developer/try-token`: a 15-minute bearer for the portal's Try it, bound to the session and the sandbox's
 * Test key. Refresh at 12 minutes; keep it in memory only, never in storage or a URL.
 */
export const TryTokenSchema = z.object({
  token: z.string(),
  expiresAt: TimestampSchema,
});
export type TryToken = z.infer<typeof TryTokenSchema>;

/** One call of the sandbox's key, as the request log lists it. Bodies come with the detail, never the list. */
export const RequestLogEntrySchema = z.object({
  id: IdSchema,
  requestId: z.string(),
  at: TimestampSchema,
  method: z.string(),
  /** The route pattern (`/api/v1/passes/:id`), null when no route matched. */
  route: z.string().nullable(),
  path: z.string(),
  /** The query string with secrets and personal values blanked. */
  query: z.string().nullable(),
  status: z.number().int(),
  /** The `code` of a problem+json answer. */
  code: z.string().nullable(),
  durationMs: z.number().int().nonnegative(),
  keyId: IdSchema.nullable(),
  mode: ModeSchema,
  via: z.literal('try').nullable(),
  /** The caller's tool as a short name (`curl/8.7.1`, `node`, `python-requests`), never the User-Agent header. Null when unknown. */
  client: z.string().max(32).nullable(),
  /** Request and response bodies are stored and still readable (24 hours, developer Test traffic). */
  hasBodies: z.boolean(),
  /** The pass, template or key the route touched. */
  resourceId: IdSchema.nullable(),
  /** The `PassBook-Version` date the call pinned. */
  apiVersion: z.string().nullable(),
  /** Which headers the call carried. Presence only, never a value. */
  flags: z.object({ idempotencyKey: z.boolean(), ifMatch: z.boolean(), version: z.boolean() }),
});
export type RequestLogEntry = z.infer<typeof RequestLogEntrySchema>;

/** Bodies are redacted JSON, or a one-line marker for anything else. */
export const RequestLogDetailSchema = RequestLogEntrySchema.extend({
  requestBody: z.string().nullable(),
  responseBody: z.string().nullable(),
  bodiesExpireAt: TimestampSchema.nullable(),
  /** Whether the org records bodies: false reads "Bodies off for this org". */
  bodiesRecorded: z.boolean(),
  /** A stored body was cut at 8 KB, or was too large to keep. */
  bodiesTruncated: z.boolean(),
});
export type RequestLogDetail = z.infer<typeof RequestLogDetailSchema>;

export const RequestLogQuerySchema = z.object({
  keyId: IdSchema.optional(),
  /** `2xx`, `3xx`, `4xx`, `5xx` or one status. */
  status: z
    .string()
    .regex(/^(?:[1-5]xx|[1-5]\d\d)$/)
    .optional(),
  code: z
    .string()
    .regex(/^[A-Z0-9_]{2,64}$/)
    .optional(),
  passId: IdSchema.optional().describe('Calls that touched this pass, template or key.'),
  version: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Calls that pinned this PassBook-Version date.'),
  /** Matches anywhere in the path. */
  path: z.string().min(1).max(200).optional(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  source: z
    .enum(['key', 'try', 'all'])
    .default('all')
    .describe('key: calls with a sandbox key; try: Run here; all: both.'),
  portal: z
    .enum(['show', 'hide'])
    .default('show')
    .describe("hide: leave out the portal's own background reads (client portal)."),
  after: IdSchema.optional().describe('Only calls newer than this log id: the listener cursor.'),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
/** `capped`: the sandbox's log is full for this hour (2,000 rows) or in all (20,000), so newer calls are not recorded. */
export const RequestLogPageSchema = pageOf(RequestLogEntrySchema).extend({
  capped: z.enum(['hour', 'total']).nullable(),
  /** Whether the org records bodies. */
  bodiesRecorded: z.boolean(),
});
/** An org's Test calls: a signed-in member names the org; a key or token reads its own. */
export const OrgRequestLogQuerySchema = RequestLogQuerySchema.extend({
  orgId: IdSchema.optional(),
  key: IdSchema.optional().describe('Alias of keyId.'),
});

/** The "Your API" rail: the sandbox key's mode, scopes and tier, and the calls of the last hour. */
export const ApiRailSchema = z.object({
  mode: ModeSchema,
  scopes: z.array(ApiScopeSchema),
  tier: z.enum(['standard', 'high', 'bulk']),
  limitPerMinute: z.number().int().positive(),
  callsLastHour: z
    .number()
    .int()
    .nonnegative()
    .describe("Calls in the last hour, without the portal's own background reads."),
  series: z
    .array(z.number().int().nonnegative())
    .length(12)
    .describe('The same calls in five-minute buckets, oldest first.'),
  key: z.object({ id: IdSchema, name: z.string(), prefix: z.string() }).nullable(),
});
export type ApiRail = z.infer<typeof ApiRailSchema>;

/** What a pasted id is: a request id (a Cloudflare ray or a UUID) or the id of an object in the caller's sandbox. */
export const ResolveQuerySchema = z.object({
  id: z
    .string()
    .regex(
      /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{16}-[A-Za-z]{3})$/,
    ),
});
export const ResolvedSchema = z.object({
  kind: z.enum(['request', 'pass', 'template', 'org']),
  /** Where it opens, always inside the portal: the request's log row, the log filtered to the object, or the console. */
  href: z.string(),
  /** `GET /passes` for a request; the object's name otherwise. */
  label: z.string(),
});
export type Resolved = z.infer<typeof ResolvedSchema>;

/** `POST /developers/search-miss`: a search term that found nothing. Re-checked on arrival; anything else is dropped. */
export const SearchMissSchema = z.object({ term: z.string().max(200) });
/**
 * The quickstart's steps, as the page reports them. The body names a step and nothing else: the org is the
 * session's sandbox, so the beacon carries no person, pass or key.
 */
export const QUICKSTART_STEPS = [
  'view',
  'sandbox',
  'run',
  'live',
  'change',
  'home',
  'fail',
] as const;
export const QuickstartBeaconSchema = z.object({
  step: z.enum(QUICKSTART_STEPS),
  /** A problem code for `fail`; a stable catalog code, never a message. */
  code: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{1,63}$/)
    .optional(),
});
export type QuickstartBeacon = z.infer<typeof QuickstartBeaconSchema>;

/** What the funnel knows of the last 30 days of sandboxes: counts by step, and time to first pass from the page view. */
export const DeveloperFunnelSchema = z.object({
  windowDays: z.number().int(),
  sandboxes: z.number().int(),
  viewed: z.number().int(),
  called: z.number().int(),
  passed: z.number().int(),
  previewed: z.number().int(),
  /** Of the sandboxes that viewed the quickstart, the share that made a pass (0..1); null with none. */
  completion: z.number().nullable(),
  /** Page view to first pass, in ms; null until a sandbox has both. */
  ttfpP50Ms: z.number().int().nullable(),
  ttfpP90Ms: z.number().int().nullable(),
  ttfpSamples: z.number().int(),
});
export type DeveloperFunnel = z.infer<typeof DeveloperFunnelSchema>;

/** `email`: an email-link session, which opens no developer features. `none`: signed in without the role. */
export const DeveloperAccessSchema = z.object({
  access: z.enum(['yes', 'none', 'email']),
  signInUrl: z.string().optional(),
});
