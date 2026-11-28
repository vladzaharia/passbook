import { z } from 'zod';
import { IdSchema, ModeSchema, PlainLineSchema, pageOf, TimestampSchema } from './common.ts';
import { ScannerSettingsSchema, TimeZoneSchema } from './scan.ts';
import { ZoneIdsSchema } from './scan-access.ts';
import { ScanCustomerViewSchema } from './scan-customer.ts';
import { CreatableDeviceRoleSchema } from './scan-device.ts';
import { ScanLiveDraftSchema } from './scan-draft.ts';
import { ScanOccupancySchema, ScanOutCauseSchema, ScanPlaceRevSchema } from './scan-occupancy.ts';
import { ScannerAcceptsSchema, ScannerKindSchema, ScannerSchema } from './scanners.ts';

export const ScanWatchSchema = z.strictObject({
  scannerIds: z.array(IdSchema).max(8).default([]),
  allOrg: z.boolean().default(false),
  /** A scanning session's devices, its zones or one event. Absent: not watched. */
  sessionIds: z.array(IdSchema).max(8).optional(),
  eventId: IdSchema.optional(),
  zoneIds: ZoneIdsSchema.optional(),
});
export const ScannerSetupSchema = ScannerSchema.extend({
  sessionId: IdSchema.optional(),
  adminSession: z.boolean().default(false),
  /** `name` is null for an API key: keys get ids, not member names. */
  adminUser: z.object({ id: IdSchema, name: z.string().nullable() }).nullable(),
  watch: ScanWatchSchema.nullable(),
});
export type ScannerSetup = z.infer<typeof ScannerSetupSchema>;
export const ScannerSetupListSchema = pageOf(ScannerSetupSchema);

export const CreateScannerSetupSchema = z.object({
  orgId: IdSchema,
  name: PlainLineSchema(40),
  kind: ScannerKindSchema.default('device'),
  deviceRole: CreatableDeviceRoleSchema.default('scan'),
  accepts: ScannerAcceptsSchema.nullable().optional(),
  settings: ScannerSettingsSchema.partial().optional(),
  timeZone: TimeZoneSchema,
  watch: ScanWatchSchema.nullable().optional(),
  /** An admin-managed setup uses its owner's platform session, never a device token. */
  adminUserId: IdSchema.optional(),
});
export const UpdateScannerSetupSchema = z.object({
  name: PlainLineSchema(40).optional(),
  deviceRole: CreatableDeviceRoleSchema.optional(),
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
  occupancy: ScanOccupancySchema.nullable().optional(),
  /** The places this scan changed, with revisions. Only monitors get them. */
  places: z.array(ScanPlaceRevSchema).max(8).optional(),
  outCause: ScanOutCauseSchema.nullable().optional(),
  /** A monitor with Desk actions and a signed-in person gets the scan it may let in. */
  scanId: IdSchema.optional(),
  /** The refused scan this row overrides. */
  overrideOf: IdSchema.nullable().optional(),
  /** The staff name and device that overrode this row. */
  resolvedBy: z.object({ staff: z.string().nullable(), device: z.string() }).nullable().optional(),
  /** The request `ref` a customer body replaces. */
  replaces: z.string().min(1).max(64).nullable().optional(),
  /** What a customer screen draws. Only customer audiences get it. */
  customer: ScanCustomerViewSchema.nullable().optional(),
});
export type ScanLiveRow = z.infer<typeof ScanLiveRowSchema>;
export const ScanLiveSnapshotSchema = z.object({
  cursor: z.string().nullable(),
  rows: z.array(ScanLiveRowSchema).max(100),
  /** A customer screen's session welcome line, for the idle screen. */
  welcome: z.string().max(40).optional(),
  places: z.array(ScanPlaceRevSchema).max(64).optional(),
});
/** Sent only to the device whose refusal was overridden, as its own socket message. */
export const ScanLiveResolvedSchema = z.object({
  of: IdSchema,
  outcome: z.enum(['ok', 'heads_up', 'refused']),
  by: z.object({ staff: z.string().nullable(), device: z.string() }),
});
/** A tag request an admin sent to this device, or its cancellation. Sent to the device's socket only. */
export const ScanLiveEnrollSchema = z.union([
  z.object({ id: IdSchema, expiresAt: TimestampSchema }),
  z.object({ id: IdSchema, cancelled: z.literal(true) }),
]);
export const ScanLiveMessageSchema = z.union([
  ScanLiveSnapshotSchema,
  z.object({ resolved: ScanLiveResolvedSchema }),
  z.object({ control: z.literal('reset') }),
  z.object({ enroll: ScanLiveEnrollSchema }),
  z.object({ draft: ScanLiveDraftSchema }),
]);
