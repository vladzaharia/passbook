import { z } from 'zod';
import { pageOf, TimestampSchema } from './common.ts';

/** Honest vocabulary, sorted by severity in the UI. */
export const ComponentStateSchema = z.enum([
  'failing',
  'degraded',
  'not_configured',
  'configured',
  /** An optional feature with nothing using it. Neutral, not a problem. */
  'not_in_use',
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
/** `fresh=1` skips the short status cache (Recheck). */
export const StatusQuerySchema = z.object({ fresh: z.enum(['0', '1']).optional() });
export const HealthResponseSchema = z.object({ ok: z.literal(true) });

export const WorkflowRunSchema = z.object({
  instanceId: z.string(),
  kind: z.enum(['template_import', 'bulk_reissue', 'connection_sync', 'broadcast', 'pass_import']),
  orgId: z.string().nullable(),
  targetId: z.string().nullable(),
  status: z.enum(['queued', 'running', 'complete', 'errored', 'terminated']),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema.nullable(),
  errorCode: z.string().nullable(),
});
export const WorkflowRunListSchema = pageOf(WorkflowRunSchema);

/** What the public page shows of a component: a name and one of three states. Nothing about any organization. */
export const PublicStateSchema = z.enum(['operational', 'degraded', 'outage', 'off']);
export const PublicComponentIdSchema = z.enum([
  'api',
  'apple_push',
  'email',
  'webhooks',
  'google',
  'samsung',
]);
export const PublicIncidentSchema = z.object({
  id: z.string(),
  title: z.string(),
  note: z.string(),
  component: PublicComponentIdSchema.nullable(),
  impact: z.enum(['notice', 'degraded', 'outage']),
  startedAt: TimestampSchema,
  resolvedAt: TimestampSchema.nullable(),
});
/** A platform admin opens a note; the page shows it until it is resolved (then 14 days more). */
export const OpenIncidentSchema = z.object({
  title: z.string().trim().min(1).max(120),
  note: z.string().trim().min(1).max(600),
  component: PublicComponentIdSchema.nullable().default(null),
  impact: PublicIncidentSchema.shape.impact,
});
export const IncidentListSchema = z.object({ items: z.array(PublicIncidentSchema) });
export const PublicStatusSchema = z.object({
  overall: z.enum(['operational', 'degraded', 'outage']),
  components: z.array(
    z.object({ id: PublicComponentIdSchema, label: z.string(), state: PublicStateSchema }),
  ),
  incidents: z.array(PublicIncidentSchema),
  checkedAt: TimestampSchema,
});
export type PublicStatus = z.infer<typeof PublicStatusSchema>;
