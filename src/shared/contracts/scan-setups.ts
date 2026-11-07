import { z } from 'zod';
import { IdSchema, ModeSchema, PlainLineSchema, pageOf, TimestampSchema } from './common.ts';
import { ScannerSettingsSchema, TimeZoneSchema } from './scan.ts';
import {
  DeviceRoleSchema,
  ScannerAcceptsSchema,
  ScannerKindSchema,
  ScannerSchema,
} from './scanners.ts';

export const ScanWatchSchema = z.strictObject({
  scannerIds: z.array(IdSchema).max(8).default([]),
  allOrg: z.boolean().default(false),
});
export const ScannerSetupSchema = ScannerSchema.extend({
  sessionId: IdSchema.optional(),
  adminSession: z.boolean().default(false),
  adminUser: z.object({ id: IdSchema, name: z.string() }).nullable(),
  watch: ScanWatchSchema.nullable(),
});
export type ScannerSetup = z.infer<typeof ScannerSetupSchema>;
export const ScannerSetupListSchema = pageOf(ScannerSetupSchema);

export const CreateScannerSetupSchema = z.object({
  orgId: IdSchema,
  name: PlainLineSchema(40),
  kind: ScannerKindSchema.default('device'),
  deviceRole: DeviceRoleSchema.default('scan'),
  accepts: ScannerAcceptsSchema.nullable().optional(),
  settings: ScannerSettingsSchema.partial().optional(),
  timeZone: TimeZoneSchema,
  watch: ScanWatchSchema.nullable().optional(),
  /** An admin-managed setup uses its owner's platform session, never a device token. */
  adminUserId: IdSchema.optional(),
});
export const UpdateScannerSetupSchema = z.object({
  name: PlainLineSchema(40).optional(),
  deviceRole: DeviceRoleSchema.optional(),
  accepts: ScannerAcceptsSchema.nullable().optional(),
  settings: ScannerSettingsSchema.partial().optional(),
  watch: ScanWatchSchema.nullable().optional(),
});
export const CreatedScannerSetupSchema = ScannerSetupSchema.extend({
  pairing: z.object({ code: z.string(), url: z.string(), expiresAt: TimestampSchema }).nullable(),
});
export const StartAdminScannerSchema = z.object({ orgId: IdSchema, timeZone: TimeZoneSchema });
export const AdminScannerStartedSchema = z.object({
  setupId: IdSchema,
  orgId: IdSchema,
  mode: ModeSchema,
  timeZone: TimeZoneSchema,
});

export const ScanLiveRowSchema = z.object({
  id: IdSchema,
  at: TimestampSchema,
  scannerId: IdSchema,
  scannerName: z.string(),
  passId: IdSchema.nullable(),
  holder: z.string().nullable(),
  photoUrl: z.string().nullable(),
  kind: z.enum(['ok', 'heads_up', 'refused', 'ready', 'undo']),
  direction: z.enum(['in', 'out']).nullable(),
  label: z.string(),
  /** Manual lookup must never publish a person's identity to the customer screen. */
  presented: z.boolean(),
});
export type ScanLiveRow = z.infer<typeof ScanLiveRowSchema>;
export const ScanLiveSnapshotSchema = z.object({
  cursor: z.string().nullable(),
  rows: z.array(ScanLiveRowSchema).max(100),
});
export const ScanLiveMessageSchema = z.union([
  ScanLiveSnapshotSchema,
  z.object({ control: z.literal('reset') }),
]);
