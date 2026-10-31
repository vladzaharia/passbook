import { z } from 'zod';
import { TimestampSchema } from './common.ts';

/** Honest vocabulary, sorted by severity in the UI. */
export const ComponentStateSchema = z.enum([
  'failing',
  'degraded',
  'not_configured',
  'configured',
  'verified',
]);

export const ComponentStatusSchema = z.object({
  id: z.string(),
  kind: z.enum([
    'database',
    'storage',
    'queue',
    'workflow',
    'identity',
    'email',
    'oidc',
    'connection',
    'cron',
    'build',
  ]),
  label: z.string(),
  state: ComponentStateSchema,
  detail: z.string().nullable(),
  checkedAt: TimestampSchema,
  data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});
export const StatusResponseSchema = z.object({
  overall: ComponentStateSchema,
  build: z.object({
    id: z.string().nullable(),
    tag: z.string().nullable(),
    timestamp: z.string().nullable(),
  }),
  components: z.array(ComponentStatusSchema),
});
export const HealthResponseSchema = z.object({ ok: z.literal(true) });

export const WorkflowRunSchema = z.object({
  instanceId: z.string(),
  kind: z.enum(['template_import', 'bulk_reissue', 'connection_sync']),
  orgId: z.string().nullable(),
  targetId: z.string().nullable(),
  status: z.enum(['queued', 'running', 'complete', 'errored', 'terminated']),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema.nullable(),
  errorCode: z.string().nullable(),
});
export const WorkflowRunListSchema = z.object({ items: z.array(WorkflowRunSchema) });
