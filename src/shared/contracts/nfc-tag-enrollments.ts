import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.ts';
import { TagBindingSchema, TagErrorCodeSchema, TagReadSchema, TagScopeSchema } from './nfc-tags.ts';

/** Remote tag enrollment: the admin's request, the scanners it can go to, and the device's side. */
export const TagEnrollmentStateSchema = z.enum([
  'pending',
  'done',
  'cancelled',
  'declined',
  'expired',
  'failed',
]);
/** The admin's view of a remote enrollment. */
export const TagEnrollmentSchema = z.object({
  id: IdSchema,
  passId: IdSchema,
  scannerId: IdSchema,
  scannerName: z.string(),
  scope: TagScopeSchema,
  state: TagEnrollmentStateSchema,
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
  endedAt: TimestampSchema.nullable(),
  /** The device fetched the request and shows it. */
  shownAt: TimestampSchema.nullable(),
  /** Set when `state` is `done`. */
  binding: TagBindingSchema.nullable(),
  errorCode: TagErrorCodeSchema.nullable(),
  /** The bound tag's four hex digits, once done: what the admin checks against the fob. */
  hint: z
    .string()
    .regex(/^[0-9A-F]{4}$/)
    .nullable(),
});
export type TagEnrollment = z.infer<typeof TagEnrollmentSchema>;
export const CreateTagEnrollmentSchema = z.strictObject({
  scannerId: IdSchema,
  binding: TagScopeSchema.default('pass'),
});
/** A scanner an admin can send a request to. */
export const TagScannerSchema = z.object({
  id: IdSchema,
  name: z.string(),
  sessionName: z.string().nullable(),
  role: z.enum(['door', 'desk', 'manager']).nullable(),
  online: z.boolean(),
  /** Why the scanner cannot take a request now; null when it can. */
  unavailable: z.enum(['offline', 'no_tags', 'requests_off', 'busy', 'mode', 'screen']).nullable(),
  secureOnly: z.boolean(),
  lastUsedAt: TimestampSchema.nullable(),
});

export type TagScanner = z.infer<typeof TagScannerSchema>;

/** What the device shows for a request an admin sent it. No pass data beyond the two names. */
export const ScanTagEnrollmentSchema = z.object({
  id: IdSchema,
  holderName: z.string(),
  passTitle: z.string(),
  scope: TagScopeSchema,
  requestedByName: z.string().nullable(),
  expiresAt: TimestampSchema,
});
export const ScanTagEnrollmentPendingSchema = z.object({
  enrollment: ScanTagEnrollmentSchema.nullable(),
});
export const ScanTagEnrollmentCompleteRequestSchema = z.strictObject({ tag: TagReadSchema });

export const TagScannerQuerySchema = z.object({ orgId: IdSchema });
/** What the device shows when its tag was bound. */
export const ScanTagEnrollmentDoneSchema = z.object({
  status: z.literal('done'),
  hint: z.string().regex(/^[0-9A-F]{4}$/),
  scope: TagScopeSchema,
  bindingId: IdSchema,
});
export const ScanTagEnrollmentDeclinedSchema = z.object({ status: z.literal('declined') });
