import { z } from 'zod';
import { IdSchema, JsonSchema, pageOf, TimestampSchema } from './common.ts';

export const ConnectionModeSchema = z.enum(['poll', 'webhook', 'hybrid', 'manual', 'snapshot']);
export type ConnectionMode = z.infer<typeof ConnectionModeSchema>;
export const ConnectionHealthSchema = z.enum([
  'unknown',
  'healthy',
  'degraded',
  'failing',
  'paused',
  'disabled',
]);

export const MappingEntrySchema = z.object({
  from: z.string().max(500),
  transform: z
    .object({
      kind: z.enum(['enum', 'bool-status', 'date', 'constant', 'trim', 'upper', 'lower', 'join']),
      options: z.record(z.string(), JsonSchema).optional(),
    })
    .optional(),
});
export const MappingSchema = z.record(z.string(), MappingEntrySchema);

/** The sender recipes of the webhook-push connector; fixed once a connection exists. */
export const RecipeIdSchema = z.enum([
  'custom',
  'shopify-orders',
  'shopify-customers',
  'stripe-subscriptions',
  'stripe-payments',
  'calcom-bookings',
  'woocommerce-orders',
  'tickettailor-tickets',
]);
export type RecipeId = z.infer<typeof RecipeIdSchema>;

/** Voids the bound pass when the upstream record matches. `in` is strict equality, no case folding. */
export const VoidRuleSchema = z
  .object({
    from: z.string().min(1).max(500),
    op: z.enum(['in', 'present']),
    values: z
      .array(z.union([z.string().max(200), z.number(), z.boolean()]))
      .min(1)
      .max(20)
      .optional(),
  })
  .refine((r) => (r.op === 'in') === (r.values !== undefined), {
    path: ['values'],
    message: 'Only "is one of" takes values.',
  });
export type VoidRule = z.infer<typeof VoidRuleSchema>;
export const VoidWhenSchema = z.array(VoidRuleSchema).max(8);

/** Seconds the previous webhook secret stays valid after a replacement. 0 drops it at once. */
export const SecretOverlapSchema = z.union([
  z.literal(0),
  z.literal(3600),
  z.literal(86_400),
  z.literal(604_800),
]);

/** Connector picker groups, in the order they show. */
export const ConnectorCategorySchema = z.enum(['files', 'apis', 'commerce', 'bookings', 'try']);
export type ConnectorCategory = z.infer<typeof ConnectorCategorySchema>;

/** A sender recipe as the console lists it: the starting point of a webhook connection. */
export const RecipeInfoSchema = z.object({
  id: RecipeIdSchema,
  label: z.string(),
  /** Picker group of the sender's tile. */
  category: ConnectorCategorySchema.default('apis'),
  /** True when the sender generates the secret and the admin pastes it. */
  pasteSecret: z.boolean(),
  /** Whether the org's plan allows this recipe. Always true without an org. */
  entitled: z.boolean(),
  outputFields: z.record(
    z.string(),
    z.object({
      type: z.enum(['string', 'number', 'boolean', 'date']),
      description: z.string().optional(),
    }),
  ),
  mapping: MappingSchema,
  holderEmailField: z.string(),
  voidWhen: VoidWhenSchema,
});
export type RecipeInfo = z.infer<typeof RecipeInfoSchema>;

export const ConnectorInfoSchema = z.object({
  type: z.string(),
  version: z.number().int(),
  displayName: z.string(),
  /** One line for the connector picker. */
  description: z.string().default(''),
  /** Picker group. */
  category: ConnectorCategorySchema.default('apis'),
  /** Position within the group; lower first. */
  order: z.number().int().default(0),
  capabilities: z.object({
    poll: z.boolean(),
    delta: z.boolean(),
    webhook: z.boolean(),
    import: z.boolean(),
    snapshot: z.boolean(),
    /** Records come from uploaded files (`/connections/{id}/files`). */
    upload: z.boolean().default(false),
  }),
  /** JSON Schema that drives the config form. */
  configSchema: JsonSchema,
  /** Write-only fields; values are never returned. */
  secretSchema: JsonSchema.nullable(),
  outputFields: z.record(
    z.string(),
    z.object({
      type: z.enum(['string', 'number', 'boolean', 'date']),
      description: z.string().optional(),
    }),
  ),
  defaults: z.object({
    intervalSeconds: z.number().int(),
    maxConcurrency: z.number().int(),
    requestsPerMinute: z.number().int(),
    timeoutMs: z.number().int(),
  }),
  /** Sender recipes; empty for connectors without any. */
  recipes: z.array(RecipeInfoSchema).default([]),
  /** Whether the org's plan allows this connector (for a sender, with no recipe). Always true without an org. */
  entitled: z.boolean(),
});
export const ConnectorListSchema = pageOf(ConnectorInfoSchema);

export const ConnectionSchema = z.object({
  id: IdSchema,
  orgId: IdSchema,
  connectorType: z.string(),
  /** The version `config` is shown in: a config stored by an older version is shown migrated. */
  connectorVersion: z.number().int(),
  name: z.string(),
  config: z.record(z.string(), JsonSchema),
  hasCredential: z.boolean(),
  hasWebhookSecret: z.boolean(),
  mapping: MappingSchema.nullable(),
  defaultTemplateId: IdSchema.nullable(),
  holderEmailField: z.string().nullable(),
  autoCreate: z.boolean(),
  autoEmail: z.boolean(),
  onMissing: z.enum(['keep', 'flag', 'void']),
  voidWhen: VoidWhenSchema,
  /** Until when the previous webhook secret is still accepted. */
  webhookPrevUntil: TimestampSchema.nullable(),
  mode: ConnectionModeSchema,
  intervalSeconds: z.number().int().nullable(),
  maxConcurrency: z.number().int().nullable(),
  requestsPerMinute: z.number().int().nullable(),
  enabled: z.boolean(),
  health: ConnectionHealthSchema,
  consecutiveFailures: z.number().int(),
  breakerOpenUntil: TimestampSchema.nullable(),
  nextRunAt: TimestampSchema.nullable(),
  lastRunAt: TimestampSchema.nullable(),
  lastSuccessAt: TimestampSchema.nullable(),
  lastErrorCode: z.string().nullable(),
  lastErrorAt: TimestampSchema.nullable(),
  webhookUrl: z.string().nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type ConnectionDto = z.infer<typeof ConnectionSchema>;
/** `webhookSecret` is present only in the response that generated it. */
export const ConnectionCreatedSchema = ConnectionSchema.extend({
  webhookSecret: z.string().optional(),
});

export const ConnectionRunSchema = z.object({
  id: IdSchema,
  trigger: z.enum(['schedule', 'webhook', 'admin', 'user', 'test', 'backfill']),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema.nullable(),
  outcome: z.enum(['running', 'unchanged', 'changed', 'error', 'skipped']),
  recordsSeen: z.number().int().nullable(),
  passesChanged: z.number().int().nullable(),
  /** Null on runs from before the counts were kept. */
  passesCreated: z.number().int().nullable(),
  passesVoided: z.number().int().nullable(),
  recordsFailed: z.number().int().nullable(),
  errorCode: z.string().nullable(),
  /** First failing records of the run: `ref: CODE path message`, one per line. */
  errorDetail: z.string().nullable().optional(),
  httpStatus: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
});

export const ConnectionDetailSchema = ConnectionSchema.extend({
  runs: z.array(ConnectionRunSchema),
  metrics: z.object({
    p50Ms: z.number().nullable(),
    p95Ms: z.number().nullable(),
    errorRate: z.number().nullable(),
    passCount: z.number().int(),
  }),
});

export const ConnectionListQuerySchema = z.object({
  orgId: IdSchema.optional(),
  health: ConnectionHealthSchema.optional(),
  /** Name contains. */
  q: z.string().max(200).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
/** A list row: the connection plus the passes bound to it. */
export const ConnectionSummarySchema = ConnectionSchema.extend({
  passCount: z.number().int().nonnegative().default(0),
});
export const ConnectionListSchema = pageOf(ConnectionSummarySchema);

export const CreateConnectionSchema = z.object({
  orgId: IdSchema,
  connectorType: z.string(),
  name: z.string().min(1).max(120),
  config: z.record(z.string(), JsonSchema),
  secrets: z.record(z.string(), z.string().max(4096)).optional(),
  webhookSecret: z.string().min(16).max(256).optional(),
  mapping: MappingSchema.optional(),
  defaultTemplateId: IdSchema.optional(),
  holderEmailField: z.string().max(200).optional(),
  autoCreate: z.boolean().optional(),
  autoEmail: z.boolean().optional(),
  onMissing: z.enum(['keep', 'flag', 'void']).optional(),
  voidWhen: VoidWhenSchema.optional(),
  mode: ConnectionModeSchema.optional(),
  intervalSeconds: z.number().int().min(60).optional(),
  maxConcurrency: z.number().int().min(1).max(20).optional(),
  requestsPerMinute: z.number().int().min(1).max(6000).optional(),
  /** File upload: the draft (`POST /connections/uploads`) that becomes revision 1. */
  fileId: IdSchema.optional(),
});
export const UpdateConnectionSchema = CreateConnectionSchema.omit({
  orgId: true,
  connectorType: true,
  fileId: true,
})
  .partial()
  .extend({
    enabled: z.boolean().optional(),
    /** With `webhookSecret`: how long the replaced secret stays valid. Default one day. */
    overlapSeconds: SecretOverlapSchema.optional(),
    /** null restores the connector default. */
    maxConcurrency: z.number().int().min(1).max(20).nullable().optional(),
    requestsPerMinute: z.number().int().min(1).max(6000).nullable().optional(),
  });
/** Query of the generate-secret call: how long the replaced secret stays valid (default one day). */
export const RotateWebhookSecretQuerySchema = z.object({
  overlapSeconds: z.coerce.number().pipe(SecretOverlapSchema).default(86_400),
});

/** The first record the source returned, as JSON pointers and short previews. */
export const SampleFieldSchema = z.object({ pointer: z.string(), preview: z.string() });
export const TestConnectionResponseSchema = z.object({
  ok: z.boolean(),
  detail: z.string().optional(),
  errorCode: z.string().optional(),
  durationMs: z.number().int(),
  sample: z.array(SampleFieldSchema).optional(),
});
/** Operator confirmation that the source system was checked for an uncertain webhook chunk. */
export const ResolveWebhookFailureResponseSchema = z.object({
  ok: z.literal(true),
  /** Uncertain items marked resolved by this call. */
  resolved: z.number().int().positive(),
  /** `resolved` when no other item is left; otherwise the chunk stays replayable. */
  state: z.enum(['failed', 'blocked', 'resolved']),
});
export const SyncNowResponseSchema = z.object({
  runId: IdSchema,
  workflowInstanceId: z.string(),
  /** The operation that shows the run; null when the sync joined a run that was already open. */
  operationId: IdSchema.nullable(),
});
export const WebhookAckSchema = z.object({ accepted: z.literal(true) });

export const ConnectionRunsQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(20),
});
export const ConnectionRunListSchema = pageOf(ConnectionRunSchema);
export const ConnectionsSummarySchema = z.object({
  total: z.number().int(),
  byHealth: z.record(z.string(), z.number().int()),
  attention: z.array(
    z.object({
      id: IdSchema,
      orgId: IdSchema,
      name: z.string(),
      health: ConnectionHealthSchema,
      lastErrorCode: z.string().nullable(),
      lastErrorAt: TimestampSchema.nullable(),
    }),
  ),
});
