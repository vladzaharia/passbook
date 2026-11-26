import { z } from 'zod';
import { IdSchema, pageOf, TimestampSchema } from './common.ts';

export const OrgLifecycleParamsSchema = z.strictObject({ orgId: IdSchema });
export const OrgExportParamsSchema = z.strictObject({ orgId: IdSchema, exportId: IdSchema });
export const OrgExportDownloadParamsSchema = z.strictObject({ exportId: IdSchema });
export const OrgExportDownloadQuerySchema = z.strictObject({
  exp: z.coerce.number().int().positive(),
  sig: z.string().regex(/^[0-9a-f]{64}$/),
});

/** The owner types the organization's slug. */
export const CloseOrgSchema = z.strictObject({ confirmSlug: z.string().trim().min(1).max(64) });

export const OrgLifecycleSchema = z.object({
  orgId: IdSchema,
  status: z.enum(['active', 'suspended', 'closed']),
  closedAt: TimestampSchema.nullable(),
  /** The close window ends here; a purge may start after it unless a legal hold stands. */
  purgeAfter: TimestampSchema.nullable(),
  purging: z.boolean(),
  purged: z.boolean(),
  held: z.boolean(),
  canReopen: z.boolean(),
});

export const OrgExportSchema = z.object({
  id: IdSchema,
  state: z.enum(['queued', 'running', 'ready', 'failed', 'expired']),
  createdAt: TimestampSchema,
  finishedAt: TimestampSchema.nullable(),
  /** The archive is removed after this. */
  expiresAt: TimestampSchema.nullable(),
  bytes: z.number().int().nullable(),
  /** Rows per entity. */
  entities: z.record(z.string(), z.number().int()).nullable(),
  errorCode: z.string().nullable(),
});
/** The start's answer: the export and the operation that shows its progress. */
export const OrgExportStartedSchema = OrgExportSchema.extend({ operationId: IdSchema.nullable() });
export const OrgExportListSchema = pageOf(OrgExportSchema);
export const OrgExportLinkSchema = z.object({ url: z.string(), expiresAt: TimestampSchema });

export const ClosedOrgSchema = z.object({
  id: IdSchema,
  slug: z.string(),
  name: z.string(),
  closedAt: TimestampSchema,
  purgeAfter: TimestampSchema,
  purging: z.boolean(),
  held: z.boolean(),
});
export const ClosedOrgListSchema = pageOf(ClosedOrgSchema);
