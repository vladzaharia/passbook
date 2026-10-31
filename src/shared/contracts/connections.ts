import { z } from 'zod';
import { IdSchema, JsonSchema, pageOf, TimestampSchema } from './common.ts';

export const ConnectionModeSchema = z.enum(['poll', 'webhook', 'hybrid', 'manual', 'snapshot']);
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
      kind: z.enum(['enum', 'bool-status', 'date', 'constant', 'trim', 'upper', 'lower']),
      options: z.record(z.string(), JsonSchema).optional(),
    })
    .optional(),
});
export const MappingSchema = z.record(z.string(), MappingEntrySchema);

export const ConnectorInfoSchema = z.object({
  type: z.string(),
  version: z.number().int(),
  displayName: z.string(),
  capabilities: z.object({
    poll: z.boolean(),
    delta: z.boolean(),
    webhook: z.boolean(),
    import: z.boolean(),
    snapshot: z.boolean(),
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
});
export const ConnectorListSchema = z.object({ items: z.array(ConnectorInfoSchema) });

export const ConnectionSchema = z.object({
  id: IdSchema,
  orgId: IdSchema,
  connectorType: z.string(),
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
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const ConnectionListSchema = pageOf(ConnectionSchema);

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
  mode: ConnectionModeSchema.optional(),
  intervalSeconds: z.number().int().min(60).optional(),
  maxConcurrency: z.number().int().min(1).max(20).optional(),
  requestsPerMinute: z.number().int().min(1).max(6000).optional(),
});
export const UpdateConnectionSchema = CreateConnectionSchema.omit({
  orgId: true,
  connectorType: true,
})
  .partial()
  .extend({
    enabled: z.boolean().optional(),
  });
export const TestConnectionResponseSchema = z.object({
  ok: z.boolean(),
  detail: z.string().optional(),
  errorCode: z.string().optional(),
  durationMs: z.number().int(),
});
export const SyncNowResponseSchema = z.object({ runId: IdSchema, workflowInstanceId: z.string() });
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
