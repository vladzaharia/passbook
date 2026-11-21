import { z } from 'zod';
import {
  ApiScopeSchema,
  IdSchema,
  ModeSchema,
  OrgIdSchema,
  pageOf,
  TimestampSchema,
} from './common.ts';

/** `POST /developer/sandbox`: the Turnstile token of the widget with action `developer_sandbox`. */
export const CreateDeveloperSandboxSchema = z.object({
  turnstileToken: z.string().min(1).max(4096),
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
});
export type DeveloperSandbox = z.infer<typeof DeveloperSandboxSchema>;

/**
 * The create response: the sandbox and its test key, whose secret is shown once. A retry that finds the key already
 * made has no secret to show: `key` is null and `previousKey` names it, so the page offers "Roll key".
 */
export const CreatedDeveloperSandboxSchema = DeveloperSandboxSchema.extend({
  key: z
    .object({
      id: IdSchema,
      name: z.string(),
      secret: z.string(),
      mode: z.literal('test'),
      expiresAt: TimestampSchema,
    })
    .nullable(),
  previousKey: z.object({ id: IdSchema, name: z.string() }).nullable(),
});
export type CreatedDeveloperSandbox = z.infer<typeof CreatedDeveloperSandboxSchema>;

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
  /** Request and response bodies are stored and still readable (24 hours, developer Test traffic). */
  hasBodies: z.boolean(),
});
export type RequestLogEntry = z.infer<typeof RequestLogEntrySchema>;

/** Bodies are redacted JSON, or a one-line marker for anything else. */
export const RequestLogDetailSchema = RequestLogEntrySchema.extend({
  requestBody: z.string().nullable(),
  responseBody: z.string().nullable(),
  bodiesExpireAt: TimestampSchema.nullable(),
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
  /** Matches anywhere in the path. */
  path: z.string().min(1).max(200).optional(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
/** `capped`: the sandbox's log is full for this hour (2,000 rows) or in all (20,000), so newer calls are not recorded. */
export const RequestLogPageSchema = pageOf(RequestLogEntrySchema).extend({
  capped: z.enum(['hour', 'total']).nullable(),
});

/** The "Your API" rail: the sandbox key's mode, scopes and tier, and the calls of the last hour. */
export const ApiRailSchema = z.object({
  mode: ModeSchema,
  scopes: z.array(ApiScopeSchema),
  tier: z.enum(['standard', 'high', 'bulk']),
  limitPerMinute: z.number().int().positive(),
  callsLastHour: z.number().int().nonnegative(),
  key: z.object({ id: IdSchema, name: z.string(), prefix: z.string() }).nullable(),
});
export type ApiRail = z.infer<typeof ApiRailSchema>;
