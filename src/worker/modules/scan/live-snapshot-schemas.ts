import { z } from 'zod';
import { IdSchema, ModeSchema, TimestampSchema } from '../../../shared/contracts/common.ts';

export const scannerSnapshot = z.strictObject({
  id: IdSchema,
  orgId: IdSchema,
  mode: ModeSchema,
  kind: z.enum(['device', 'terminal', 'display']),
  deviceRole: z.enum(['scan', 'customer', 'monitor']),
  name: z.string(),
  eventId: IdSchema.nullable(),
  settings: z.string(),
  timeZone: z.string(),
  tokenPrefix: z.string().nullable(),
  tokenHash: z.string().nullable(),
  csrfSecret: z.null(),
  pairedAt: TimestampSchema.nullable(),
  expiresAt: TimestampSchema.nullable(),
  lastSeenAt: TimestampSchema.nullable(),
  revokedAt: TimestampSchema.nullable(),
  staffId: IdSchema.nullable(),
  staffSince: TimestampSchema.nullable(),
  staffSeenAt: TimestampSchema.nullable(),
  updatedAt: TimestampSchema,
  hasScreens: z.boolean().optional(),
});

export const eventSnapshot = z.strictObject({
  id: IdSchema,
  orgId: IdSchema,
  mode: ModeSchema,
  name: z.string(),
  matchInput: z.string().nullable(),
  matchValues: z.string().nullable(),
  opensAt: TimestampSchema,
  closesAt: TimestampSchema,
  timeZone: z.string(),
  capacity: z.number().nullable(),
  reentry: z.boolean(),
  note: z.string().nullable(),
  updatedAt: TimestampSchema,
  archivedAt: TimestampSchema.nullable(),
});

const epoch = z.number().int().positive();
/** Epochs ride on a symbol key that JSON drops, so the sealed envelope carries them beside the proof. */
export const epochsSchema = z.strictObject({
  scanner: z.strictObject({ id: IdSchema, credential: epoch, config: epoch }).optional(),
  staff: z.strictObject({ id: IdSchema, auth: epoch }).optional(),
  session: z.strictObject({ id: IdSchema, config: epoch }).optional(),
  events: z.record(IdSchema, epoch),
});
