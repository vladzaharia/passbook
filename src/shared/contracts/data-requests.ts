import { z } from 'zod';
import { IdSchema, pageOf, TimestampSchema } from './common.ts';

export const DataRequestKindSchema = z.enum(['export', 'erasure']);
export type DataRequestKind = z.infer<typeof DataRequestKindSchema>;

export const DataRequestStateSchema = z.enum([
  'open',
  'erasing',
  'on_hold',
  'done',
  'declined',
  'withdrawn',
]);
export type DataRequestState = z.infer<typeof DataRequestStateSchema>;

export const DeclineReasonSchema = z.enum([
  'legal_obligation',
  'contract',
  'not_identified',
  'other',
]);
export type DeclineReason = z.infer<typeof DeclineReasonSchema>;

/** Days a holder waits, and the most one extension adds. */
export const DATA_REQUEST_DUE_DAYS = 30;
export const DATA_REQUEST_EXTENSION_DAYS = 60;

const PlainNote = (max: number) => z.string().trim().min(1).max(max);

export const CreateDataRequestSchema = z.object({
  orgId: IdSchema,
  kind: DataRequestKindSchema,
  note: PlainNote(1000).optional(),
});
export type CreateDataRequest = z.infer<typeof CreateDataRequestSchema>;

export const DeclineDataRequestSchema = z.object({
  reason: DeclineReasonSchema,
  message: PlainNote(500),
});

export const ExtendDataRequestSchema = z.object({
  message: PlainNote(500),
  /** Days added to the due date, once. */
  days: z
    .number()
    .int()
    .min(1)
    .max(DATA_REQUEST_EXTENSION_DAYS)
    .default(DATA_REQUEST_EXTENSION_DAYS),
});

export const DataRequestQuerySchema = z.object({ state: DataRequestStateSchema.optional() });

/** A request as the holder sees it. */
export const MyDataRequestSchema = z.object({
  id: IdSchema,
  orgId: IdSchema,
  orgName: z.string(),
  kind: DataRequestKindSchema,
  state: DataRequestStateSchema,
  createdAt: TimestampSchema,
  dueAt: TimestampSchema,
  closedAt: TimestampSchema.nullable(),
  /** Set when the org's export is ready; the link works 14 days. */
  exportReady: z.boolean(),
});
export const MyDataRequestListSchema = z.object({ items: z.array(MyDataRequestSchema) });

/** A request as org admins see it. The holder's email shows to `org:manage` only. */
export const DataRequestSchema = z.object({
  id: IdSchema,
  kind: DataRequestKindSchema,
  state: DataRequestStateSchema,
  createdAt: TimestampSchema,
  dueAt: TimestampSchema,
  overdue: z.boolean(),
  extended: z.boolean(),
  passCount: z.number().int().nonnegative(),
  contactEmail: z.string().nullable(),
  note: z.string().nullable(),
  response: z.string().nullable(),
  declineReason: DeclineReasonSchema.nullable(),
  closedAt: TimestampSchema.nullable(),
});
export type DataRequest = z.infer<typeof DataRequestSchema>;
export const DataRequestPageSchema = pageOf(DataRequestSchema);
