import { z } from 'zod';
import { IdSchema, JsonSchema, ModeSchema, pageOf, TimestampSchema } from './common.ts';
import { REMOVE_MESSAGE_MAX } from './events.ts';
import { PUSH_BUDGET_DEFAULT } from './settings.ts';
import { ValidationIssueSchema } from './templates.ts';

export const PassStatusSchema = z.enum(['active', 'voided']);
/** List filter: the two statuses, plus passes removed from Wallet (which also read as voided). */
export const PassListStatusSchema = z.enum(['active', 'voided', 'removed']);
export const FieldSourceSchema = z.enum(['manual', 'connection']);
/** Why a version was published, beside its cause. Free text in the database, closed here. */
export const PassSourceSchema = z.enum([
  'scan',
  'broadcast',
  'schedule',
  'remove',
  'restore',
  'designer',
]);
export type PassSource = z.infer<typeof PassSourceSchema>;
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
  mode: ModeSchema.default('live'),
  version: z.number().int(),
  connectionId: IdSchema.nullable(),
  externalRef: z.string().nullable().optional(),
  syncErrorCode: z.string().nullable(),
  holderEmail: z.string().nullable(),
  holderState: z.enum(['unassigned', 'waiting', 'owned']),
  ownerUserId: IdSchema.nullable(),
  /** Devices that have the pass in Wallet. */
  deviceCount: z.number().int().default(0),
  /** When the pass was removed from Wallet; null while it is not. */
  removedAt: TimestampSchema.nullable().default(null),
  modifiedAt: TimestampSchema,
  createdAt: TimestampSchema,
});
export type PassSummaryDto = z.infer<typeof PassSummarySchema>;

export const PassVersionSchema = z.object({
  version: z.number().int(),
  templateVersion: z.string(),
  cause: PassCauseSchema,
  /** Why the version was published beside its cause; null for plain edits and syncs. */
  source: PassSourceSchema.nullable().optional(),
  actorType: z.string().nullable(),
  actorId: z.string().nullable(),
  createdAt: TimestampSchema,
  purged: z.boolean(),
});

export const DeliveryEntrySchema = z.object({
  /** Outbox ids carry their kind and reason (`push:<pass>:<reason>:<uuid>`), longer than an IdSchema. */
  id: z.string().min(1).max(128),
  kind: z.enum(['push', 'email']),
  state: z.enum(['pending', 'enqueued', 'processing', 'sent', 'partial', 'failed', 'cancelled']),
  attempts: z.number().int(),
  errorCode: z.string().nullable(),
  createdAt: TimestampSchema,
  finishedAt: TimestampSchema.nullable(),
});

export const PassDeviceSchema = z.object({
  /** Last six characters of the device library id; enough to tell devices apart. */
  shortId: z.string(),
  createdAt: TimestampSchema,
  /** The newest push since the device registered. */
  lastPush: z
    .object({
      state: DeliveryEntrySchema.shape.state,
      at: TimestampSchema,
    })
    .nullable(),
});

export const PassVoidedSchema = z.object({
  at: TimestampSchema,
  actorType: z.string(),
  actorLabel: z.string().nullable(),
});

/** Notifying updates of a pass in the last 24 hours against the daily limit. */
export const PushBudgetSchema = z.object({
  used: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  /** When the oldest counted update leaves the window; null while none counts. */
  resetsAt: TimestampSchema.nullable(),
});

export type PushBudgetDto = z.infer<typeof PushBudgetSchema>;

export const PassDetailSchema = PassSummarySchema.extend({
  pushBudget: PushBudgetSchema.default({ used: 0, limit: PUSH_BUDGET_DEFAULT, resetsAt: null }),
  /** Owner's display name and email (null when unowned); the summary carries only the id. */
  ownerName: z.string().nullable(),
  ownerEmail: z.string().nullable(),
  personalization: z.record(z.string(), JsonSchema),
  fieldSources: z.record(z.string(), FieldSourceSchema),
  /** Signed pass.json of the current version, for rendering. */
  passJson: z.record(z.string(), z.unknown()),
  assetBaseUrl: z.string(),
  /** Image files the pass can load: template files plus per-pass overrides. */
  assetNames: z.array(z.string()),
  /** Users removed this pass from their account; hook B skips them until cleared. */
  blockedUsers: z.array(z.object({ id: IdSchema, name: z.string().nullable() })),
  downloadUrl: z.string(),
  publicUrl: z.string(),
  registrations: z.number().int(),
  devices: z.array(PassDeviceSchema).default([]),
  lastRefreshedAt: TimestampSchema.nullable(),
  versions: z.array(PassVersionSchema),
  deliveries: z.array(DeliveryEntrySchema),
  /** Who voided the pass and when; null while active. */
  voided: PassVoidedSchema.nullable().default(null),
  /** Issues with this pass's own content (fields, images, branding). */
  warnings: z.array(ValidationIssueSchema),
  /** Issues every pass of the template shares; the template page shows them. */
  templateWarnings: z.array(ValidationIssueSchema).default([]),
});
export type PassDetailDto = z.infer<typeof PassDetailSchema>;

export const PassListQuerySchema = z.object({
  orgId: IdSchema.optional(),
  templateId: IdSchema.optional(),
  connectionId: IdSchema.optional(),
  status: PassListStatusSchema.optional(),
  holderEmail: z.string().max(254).optional(),
  holderState: z.enum(['unassigned', 'waiting', 'owned']).optional(),
  /** true: on at least one device; false: on none. */
  onDevice: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
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
  serial: z
    .string()
    .regex(/^[A-Za-z0-9._~-]{1,100}$/, 'Use letters, digits and . _ ~ - only.')
    .optional(),
  connectionId: IdSchema.optional(),
  externalRef: z.string().max(500).optional(),
  sendEmail: z.boolean().optional(),
});
export const UpdatePassSchema = z.object({
  input: z.record(z.string(), JsonSchema).optional(),
  templateVersion: z.string().optional(),
  externalId: z.string().max(200).nullable().optional(),
  resetToConnection: z.array(z.string()).optional(),
  /** Holders get a lock-screen message for the fields this save changes; off by default. */
  notify: z.boolean().optional(),
});
/**
 * Binds an existing pass to an upstream ref, or unbinds it (both null). `resetFieldSources`
 * (default true) marks every field as connection-owned; false keeps existing sources.
 */
export const BindPassConnectionSchema = z
  .object({
    connectionId: IdSchema.nullable(),
    externalRef: z.string().min(1).max(500).nullable(),
    resetFieldSources: z.boolean().optional(),
  })
  .refine((v) => (v.connectionId === null) === (v.externalRef === null), {
    message: 'Set both connectionId and externalRef, or neither.',
    path: ['externalRef'],
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
export const BULK_PASS_LIMIT = 100;
export const BulkPassActionSchema = z.object({
  action: z.enum(['void', 'send_email', 'remove']),
  /** For `remove`: shown to holders on the lock screen. */
  message: z.string().trim().max(REMOVE_MESSAGE_MAX).optional(),
  ids: z.array(IdSchema).min(1).max(BULK_PASS_LIMIT),
  /** The caller's view: every id must belong to this org. */
  orgId: IdSchema.optional(),
});
export const BulkPassActionResponseSchema = z.object({
  /** Passes the action applied to (already voided ones count). */
  done: z.number().int(),
  /** Passes skipped, with the reason code (NO_RECIPIENT for send_email without a holder). */
  skipped: z.array(z.object({ id: IdSchema, code: z.string() })),
});

export const BulkReissueSchema = z
  .object({
    /** Required for an upgrade; a re-sign may omit it to cover every template of the identity. */
    templateId: IdSchema.optional(),
    version: z.string().optional(),
    orgId: IdSchema.optional(),
    /** `resign` rebuilds under each pass's current template version, without pushes. */
    cause: z.enum(['template_upgrade', 'resign']).default('template_upgrade'),
    /** Limits the run to passes signed by one identity. */
    identityId: IdSchema.optional(),
  })
  .refine((b) => b.templateId || (b.cause === 'resign' && b.identityId), {
    message: 'templateId is required unless re-signing an identity.',
    path: ['templateId'],
  });
export const BulkReissueResponseSchema = z.object({ workflowInstanceId: z.string() });
