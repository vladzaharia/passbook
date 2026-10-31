import { z } from 'zod';
import { IdSchema, JsonSchema, pageOf, TimestampSchema } from './common.ts';
import { ValidationIssueSchema } from './templates.ts';

export const PassStatusSchema = z.enum(['active', 'voided']);
export const FieldSourceSchema = z.enum(['manual', 'connection']);
export const PassCauseSchema = z.enum([
  'create',
  'admin',
  'api',
  'connection',
  'user_refresh',
  'template_upgrade',
  'resign',
]);

export const PassSummarySchema = z.object({
  id: IdSchema,
  orgId: IdSchema,
  templateId: IdSchema,
  templateVersion: z.string(),
  identityId: IdSchema,
  serial: z.string(),
  title: z.string().nullable(),
  subtitle: z.string().nullable(),
  externalId: z.string().nullable(),
  status: PassStatusSchema,
  version: z.number().int(),
  connectionId: IdSchema.nullable(),
  syncErrorCode: z.string().nullable(),
  holderEmail: z.string().nullable(),
  holderState: z.enum(['unassigned', 'waiting', 'owned']),
  ownerUserId: IdSchema.nullable(),
  modifiedAt: TimestampSchema,
  createdAt: TimestampSchema,
});
export type PassSummaryDto = z.infer<typeof PassSummarySchema>;

export const PassVersionSchema = z.object({
  version: z.number().int(),
  templateVersion: z.string(),
  cause: PassCauseSchema,
  actorType: z.string().nullable(),
  actorId: z.string().nullable(),
  createdAt: TimestampSchema,
  purged: z.boolean(),
});

export const DeliveryEntrySchema = z.object({
  id: IdSchema,
  kind: z.enum(['push', 'email']),
  state: z.enum(['pending', 'enqueued', 'processing', 'sent', 'partial', 'failed', 'cancelled']),
  attempts: z.number().int(),
  errorCode: z.string().nullable(),
  createdAt: TimestampSchema,
  finishedAt: TimestampSchema.nullable(),
});

export const PassDetailSchema = PassSummarySchema.extend({
  personalization: z.record(z.string(), JsonSchema),
  fieldSources: z.record(z.string(), FieldSourceSchema),
  /** Signed pass.json of the current version, for rendering. */
  passJson: z.record(z.string(), z.unknown()),
  assetBaseUrl: z.string(),
  downloadUrl: z.string(),
  publicUrl: z.string(),
  registrations: z.number().int(),
  lastRefreshedAt: TimestampSchema.nullable(),
  versions: z.array(PassVersionSchema),
  deliveries: z.array(DeliveryEntrySchema),
  warnings: z.array(ValidationIssueSchema),
});

export const PassListQuerySchema = z.object({
  orgId: IdSchema.optional(),
  templateId: IdSchema.optional(),
  connectionId: IdSchema.optional(),
  status: PassStatusSchema.optional(),
  holderEmail: z.string().max(254).optional(),
  holderState: z.enum(['unassigned', 'waiting', 'owned']).optional(),
  q: z.string().max(200).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const PassListSchema = pageOf(PassSummarySchema);

export const CreatePassSchema = z.object({
  orgId: IdSchema,
  templateId: IdSchema,
  templateVersion: z.string().optional(),
  identityId: IdSchema.optional(),
  input: z.record(z.string(), JsonSchema),
  holderEmail: z.string().max(254).optional(),
  externalId: z.string().max(200).optional(),
  serial: z.string().max(100).optional(),
  connectionId: IdSchema.optional(),
  externalRef: z.string().max(500).optional(),
  sendEmail: z.boolean().optional(),
});
export const UpdatePassSchema = z.object({
  input: z.record(z.string(), JsonSchema).optional(),
  templateVersion: z.string().optional(),
  externalId: z.string().max(200).nullable().optional(),
  resetToConnection: z.array(z.string()).optional(),
});
export const PassAssetSchema = z.object({
  name: z.string(),
  sha1: z.string(),
  size: z.number().int(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  createdAt: TimestampSchema,
});
export const PassAssetListSchema = z.object({ items: z.array(PassAssetSchema) });
/** Per-pass image override. `name` is `<slot>@<scale>x.png`, e.g. thumbnail@2x.png. Body is the PNG. */
export const PassAssetParamSchema = z.object({
  id: IdSchema,
  name: z.string().regex(/^[a-zA-Z]+(?:@[23]x)?\.png$/),
});
export const PassActionResponseSchema = PassSummarySchema;
export const RotateLinkResponseSchema = z.object({
  downloadUrl: z.string(),
  publicUrl: z.string(),
});
export const RefreshPassResponseSchema = z.object({
  accepted: z.literal(true),
  requestedAt: TimestampSchema,
});
export const ResendEmailSchema = z.object({
  to: z.string().max(254).optional(),
  attach: z.boolean().optional(),
});
export const DiffQuerySchema = z.object({
  from: z.coerce.number().int(),
  to: z.coerce.number().int(),
});
export const BulkReissueSchema = z.object({
  templateId: IdSchema,
  version: z.string().optional(),
  orgId: IdSchema.optional(),
});
export const BulkReissueResponseSchema = z.object({ workflowInstanceId: z.string() });
