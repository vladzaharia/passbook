import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.ts';

/** Workbench device passes (a Test pass of the developer's own sandbox on their phone). Behind `DEVICE_PASS_ENABLED`. */
export const DEVICE_PASS_MAX_ACTIVE = 5;
export const DEVICE_PASS_MAX_DEVICES = 3;
export const DEVICE_PASS_MAX_CODES = 5;
export const DEVICE_PASS_TTL_MS = 24 * 3_600_000;
export const DEVICE_PASS_CODE_TTL_MS = 10 * 60_000;
/** Passes a developer may make in an hour. */
export const DEVICE_PASS_PER_HOUR = 10;

export const DevicePassStateSchema = z.enum(['pending', 'active', 'voided', 'expired']);
export const DevicePassVoidReasonSchema = z.enum([
  'developer',
  'expired',
  'overshared',
  'platform',
  'pass_gone',
]);

export const CreateDevicePassSchema = z.strictObject({ passId: IdSchema });

/** The one-time link a phone opens (or the QR encodes). Shown once; a new code kills the old one. */
export const DevicePassCodeSchema = z.object({ url: z.string(), expiresAt: TimestampSchema });

export const DevicePassSchema = z.object({
  id: IdSchema,
  passId: IdSchema,
  state: DevicePassStateSchema,
  voidReason: DevicePassVoidReasonSchema.nullable(),
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
  /** Phones that registered the pass (3 at most). */
  deviceCount: z.number().int().nonnegative(),
  lastSeenAt: TimestampSchema.nullable(),
  /** Present on make, new code and Add again; never on a read. */
  code: DevicePassCodeSchema.nullable(),
});
export type DevicePassDto = z.infer<typeof DevicePassSchema>;

export const DevicePassResponseSchema = z.object({ devicePass: DevicePassSchema });
export const DevicePassListSchema = z.object({
  items: z.array(DevicePassSchema),
  /** Pending and active now, against `limit`. */
  active: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
});

/** Platform: void every device pass of one developer, or clear the block an over-shared pass left. */
export const DevicePassDeveloperSchema = z.strictObject({ userId: IdSchema });
export const VoidedDevicePassesSchema = z.object({ voided: z.number().int().nonnegative() });
