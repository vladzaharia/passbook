import { z } from 'zod';
import { IdSchema, JsonSchema, TimestampSchema } from './common.ts';
import { MappingSchema, TestConnectionResponseSchema, VoidWhenSchema } from './connections.ts';

/** What a first sync would do with the source's records. Nothing is written. */
export const ConnectionPreviewSchema = z.object({
  ok: z.boolean(),
  errorCode: z.string().optional(),
  /** Records read, at most 200. */
  records: z.number().int(),
  counts: z.object({
    create: z.number().int(),
    update: z.number().int(),
    unchanged: z.number().int(),
    /** Records that issue nothing: a "Don't issue" value, or issuing is off. */
    skipped: z.number().int(),
    errors: z.number().int(),
    /** New records held back because the template has no approved release. */
    waiting: z.number().int(),
  }),
  /** Why new records wait: TEMPLATE_IS_BLUEPRINT or a release code; null when none do. */
  releaseBlocked: z.string().nullable(),
  /** Which records were read: the last `days` days, at most `limit`; `excluded` fell before `since`. */
  window: z.object({
    days: z.number().int(),
    limit: z.number().int(),
    since: TimestampSchema,
    excluded: z.number().int(),
  }),
  /** First records by what they would do, with the template inputs they map to. */
  samples: z
    .array(
      z.object({
        ref: z.string().max(200),
        action: z.enum(['create', 'update', 'unchanged', 'skipped', 'error']),
        fields: z.record(z.string(), JsonSchema),
        message: z.string().max(300).optional(),
      }),
    )
    .max(10),
  /** The source's own fields, three cells each, for the Map step. */
  columns: z
    .array(
      z.object({
        pointer: z.string().max(500),
        label: z.string().max(200),
        samples: z.array(z.string().max(80)).max(3),
        /** Distinct text values of the records read, most common first; empty for a free-form field. */
        values: z.array(z.object({ value: z.string().max(80), count: z.number().int() })).max(20),
      }),
    )
    .max(60),
  durationMs: z.number().int(),
});
/** Tests an unsaved configuration: nothing is stored; secrets are used once and dropped. */
export const TestConfigSchema = z.object({
  orgId: IdSchema,
  connectorType: z.string().max(64),
  config: z.record(z.string(), JsonSchema),
  secrets: z.record(z.string(), z.string().max(4096)).optional(),
  /** With `?preview=true`: the mapping, rules and template the dry run applies. */
  mapping: MappingSchema.optional(),
  voidWhen: VoidWhenSchema.optional(),
  autoCreate: z.boolean().optional(),
  defaultTemplateId: IdSchema.optional(),
  /** File upload: the draft to test against. */
  fileId: IdSchema.optional(),
});
export const TestConfigQuerySchema = z.object({ preview: z.enum(['true', 'false']).optional() });
/** With `?preview=true` the dry run's fields come too (ConnectionPreviewSchema). */
export const TestConfigResponseSchema = TestConnectionResponseSchema.extend(
  ConnectionPreviewSchema.omit({ ok: true, errorCode: true, durationMs: true }).partial().shape,
);
