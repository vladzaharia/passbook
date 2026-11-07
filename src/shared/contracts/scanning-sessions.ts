import { z } from 'zod';
import {
  IdSchema,
  ModeSchema,
  PageQuerySchema,
  PlainLineSchema,
  pageOf,
  TimestampSchema,
} from './common.ts';
import { ScannerSettingsSchema, TimeZoneSchema } from './scan.ts';
import { ScannerAcceptsSchema } from './scanners.ts';

/** Layout and sign-in method are independent: an admin is another device in the session. */
export const ScanSurfaceSchema = z.enum(['phone', 'operator', 'desk', 'customer']);
export type ScanSurface = z.infer<typeof ScanSurfaceSchema>;
export const ScanSurfaceChoiceSchema = z.enum(['auto', 'phone', 'operator', 'desk', 'customer']);
export const ScanDeviceCapabilitiesSchema = z.strictObject({
  width: z.number().int().min(1).max(32768),
  height: z.number().int().min(1).max(32768),
  touch: z.boolean(),
  camera: z.enum(['unknown', 'available', 'unavailable']),
  keyboard: z.boolean(),
  nativeBarcode: z.boolean(),
  surfaces: z.array(ScanSurfaceSchema).min(1).max(4),
  preferred: ScanSurfaceSchema,
});
export type ScanDeviceCapabilities = z.infer<typeof ScanDeviceCapabilitiesSchema>;

/** Admission, staff rights, accepted passes and time zone always belong to the session. */
export const ScanDeviceOverridesSchema = ScannerSettingsSchema.pick({
  flow: true,
  reader: true,
  direction: true,
  lookup: true,
  showPhoto: true,
})
  .partial()
  .strict();
export type ScanDeviceOverrides = z.infer<typeof ScanDeviceOverridesSchema>;
export const ScanningSessionStatusSchema = z.enum(['active', 'paused', 'ended']);
export const ScanningSessionSchema = z.object({
  id: IdSchema,
  orgId: IdSchema,
  orgName: z.string(),
  mode: ModeSchema,
  name: PlainLineSchema(80),
  status: ScanningSessionStatusSchema,
  accepts: ScannerAcceptsSchema.nullable(),
  settings: ScannerSettingsSchema,
  timeZone: TimeZoneSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  deviceCount: z.number().int(),
  onlineCount: z.number().int(),
  today: z.number().int(),
});
export type ScanningSession = z.infer<typeof ScanningSessionSchema>;
export const ScanningSessionListSchema = pageOf(ScanningSessionSchema);
export const ScanningSessionQuerySchema = PageQuerySchema.extend({ orgId: IdSchema.optional() });
export const CreateScanningSessionSchema = z.strictObject({
  orgId: IdSchema,
  name: PlainLineSchema(80),
  timeZone: TimeZoneSchema,
  accepts: ScannerAcceptsSchema.nullable().default(null),
  settings: ScannerSettingsSchema.partial().optional(),
});
export const UpdateScanningSessionSchema = CreateScanningSessionSchema.omit({ orgId: true })
  .partial()
  .extend({
    status: ScanningSessionStatusSchema.optional(),
    revision: TimestampSchema.optional(),
  });
export const ScanningDeviceSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  name: z.string(),
  surface: ScanSurfaceChoiceSchema,
  effectiveSurface: ScanSurfaceSchema,
  overrides: ScanDeviceOverridesSchema,
  settings: ScannerSettingsSchema,
  capabilities: ScanDeviceCapabilitiesSchema.nullable(),
  reportedAt: TimestampSchema.nullable(),
  paired: z.boolean(),
  online: z.boolean(),
  revoked: z.boolean(),
  lastSeenAt: TimestampSchema.nullable(),
  updatedAt: TimestampSchema,
  signIn: z.enum(['paired', 'admin']),
  adminName: z.string().nullable(),
});
export type ScanningDevice = z.infer<typeof ScanningDeviceSchema>;
export const SessionActivitySchema = z.object({
  items: z
    .array(
      z.object({
        id: IdSchema,
        at: TimestampSchema,
        deviceId: IdSchema,
        deviceName: z.string(),
        passId: IdSchema.nullable(),
        title: z.string().nullable(),
        outcome: z.enum(['ok', 'heads_up', 'refused', 'undone']),
        direction: z.enum(['in', 'out']).nullable(),
      }),
    )
    .max(20),
});
export const ScanningSessionDetailSchema = ScanningSessionSchema.extend({
  devices: z.array(ScanningDeviceSchema),
  activity: SessionActivitySchema.shape.items.default([]),
});
export const CreateScanningDeviceSchema = z.strictObject({
  name: PlainLineSchema(40),
  surface: ScanSurfaceChoiceSchema.default('auto'),
  overrides: ScanDeviceOverridesSchema.default({}),
});
export const UpdateScanningDeviceSchema = CreateScanningDeviceSchema.partial().extend({
  revision: TimestampSchema.optional(),
});
export const DevicePairingSchema = z.object({
  code: z.string(),
  url: z.string(),
  expiresAt: TimestampSchema,
});
export const CreatedScanningDeviceSchema = ScanningDeviceSchema.extend({
  pairing: DevicePairingSchema.nullable(),
});
export const JoinAdminScanningSessionSchema = z.strictObject({
  sessionId: IdSchema,
  deviceKey: z.uuid(),
});
export const ScanWorkspaceSchema = z.object({
  session: ScanningSessionSchema,
  device: ScanningDeviceSchema,
});
export type ScanWorkspace = z.infer<typeof ScanWorkspaceSchema>;
export const ReportScanDeviceSchema = z.object({
  capabilities: ScanDeviceCapabilitiesSchema,
  scope: z.object({ orgId: IdSchema, setupId: IdSchema, timeZone: TimeZoneSchema }).optional(),
});
