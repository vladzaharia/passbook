import { z } from 'zod';
import { IdSchema } from './common.ts';
import { ScanRoleSchema } from './scan.ts';
import { ZoneIdsSchema } from './scan-access.ts';
import { NativeHardwareEntrySchema, ReportedHardwareSchema } from './scan-hardware.ts';

/**
 * A Staff device's layout: Handheld (`phone`) or Console (`operator`). Only `deviceRole: 'scan'`
 * has one. Layout and sign-in method are independent: an admin is another device in the session.
 */
export const ScanSurfaceSchema = z.enum(['phone', 'operator']);
export type ScanSurface = z.infer<typeof ScanSurfaceSchema>;
/** `auto` picks among the layouts the plan allows (`surfaceFor`). */
export const ScanSurfaceChoiceSchema = z.enum(['auto', ...ScanSurfaceSchema.options]);
export type ScanSurfaceChoice = z.infer<typeof ScanSurfaceChoiceSchema>;
/** The kinds a create takes. A kiosk is made by the kiosk wizard once its storage lands (K0). */
export const CreatableDeviceRoleSchema = z.enum(['scan', 'customer', 'monitor']);
export const NativeScannerCapabilitiesSchema = z.strictObject({
  platform: z.enum(['ios', 'android']),
  appVersion: z.string().max(32),
  camera: z.strictObject({
    available: z.boolean(),
    permission: z.enum(['unknown', 'prompt', 'granted', 'denied', 'restricted', 'unavailable']),
  }),
  keyboard: z.strictObject({
    supported: z.boolean(),
    connected: z.boolean().nullable(),
    connectionObservable: z.boolean(),
  }),
  nfc: z.strictObject({
    available: z.boolean(),
    reading: z.boolean(),
    /** The app reads tags without a `tagRead` request (wire v2). */
    continuous: z.boolean().optional(),
    formats: z.array(z.enum(['ndef', 'wallet-vas', 'tag-uid', 'tag-sun'])).max(4),
  }),
  /** The shell plays `{op:'haptic', pattern}` (wire v1). */
  haptics: z.boolean().optional(),
  vas: z.strictObject({
    deviceSupported: z.boolean(),
    available: z.boolean(),
    reader: z.enum(['proximityReader', 'android-native', 'none']),
    reason: z.string().max(240),
  }),
  externalReader: z.strictObject({
    mode: z.enum(['keyboard', 'unknown']),
    connected: z.boolean().nullable(),
  }),
  customerDisplay: z.strictObject({
    supported: z.boolean(),
    available: z.boolean(),
    active: z.boolean(),
  }),
  layout: z
    .strictObject({
      posture: z.enum(['unknown', 'folded', 'unfolded', 'half-folded']),
      division: z
        .strictObject({
          x: z.number().min(0).max(32768),
          y: z.number().min(0).max(32768),
          width: z.number().min(0).max(32768),
          height: z.number().min(0).max(32768),
        })
        .nullable(),
    })
    .optional(),
  /** Bridge v1, additive: one entry per unit. Reports carry the summary, not this list. */
  hardware: z.array(NativeHardwareEntrySchema).max(16).optional(),
});
export type NativeScannerCapabilities = z.infer<typeof NativeScannerCapabilitiesSchema>;
export const ScanDeviceCapabilitiesSchema = z.strictObject({
  width: z.number().int().min(1).max(32768),
  height: z.number().int().min(1).max(32768),
  touch: z.boolean(),
  camera: z.enum(['unknown', 'available', 'unavailable']),
  keyboard: z.boolean(),
  nativeBarcode: z.boolean(),
  native: NativeScannerCapabilitiesSchema.omit({ hardware: true }).optional(),
  /** Found hardware by kind and state; failed customer-screen drafts (`scan.draft_failed`). Optional. */
  hardware: z.array(ReportedHardwareSchema).max(16).optional(),
  draftFailures: z.number().int().min(1).max(1_000_000).optional(),
  surfaces: z.array(ScanSurfaceSchema).min(1).max(2),
  preferred: ScanSurfaceSchema,
});
export type ScanDeviceCapabilities = z.infer<typeof ScanDeviceCapabilitiesSchema>;
/** Layouts an old cached client may still report; a report never sets the kind, so they are ignored. */
export const LEGACY_REPORTED_LAYOUTS = ['customer', 'desk'] as const;
const ReportedLayoutSchema = z.enum([...ScanSurfaceSchema.options, ...LEGACY_REPORTED_LAYOUTS]);
export const ReportedScanDeviceCapabilitiesSchema = ScanDeviceCapabilitiesSchema.extend({
  surfaces: z.array(ReportedLayoutSchema).min(1).max(2),
  preferred: ReportedLayoutSchema,
});
export type ReportedScanDeviceCapabilities = z.infer<typeof ReportedScanDeviceCapabilitiesSchema>;

/** Shared: anyone allowed signs in. Personal: only `personalStaffId`, PIN only (SDA §2). */
export const DeviceOwnershipSchema = z.enum(['shared', 'personal']);
/** Who hears a request: the chime or takeover, the badge only, or nothing. */
export const DeviceAlertsSchema = z.enum(['ring', 'badge', 'off']);
/**
 * A Staff device's own settings (SDA §2), admin only, never through reach. Absent on read: Shared,
 * a `manager` ceiling, the layout's alerts (`defaultAlerts`) and every zone in the session.
 */
export const StaffDeviceFieldsSchema = z.strictObject({
  ownership: DeviceOwnershipSchema.optional(),
  /** The one person who signs in on a Personal device. Null or absent on a Shared one. */
  personalStaffId: IdSchema.nullable().optional(),
  /** The highest role that may sign in here; above it, `SIGN_IN_ROLE_NOT_ALLOWED`. */
  signInCeiling: ScanRoleSchema.optional(),
  alerts: DeviceAlertsSchema.optional(),
  /** Zone ids in the session that ring here and fill the default view. Null or absent: all zones. */
  coverage: ZoneIdsSchema.nullable().optional(),
});
export type StaffDeviceFields = z.infer<typeof StaffDeviceFieldsSchema>;

/** Shared Handheld badges; a Console or a Personal device rings. */
export const defaultAlerts = (surface: ScanSurface, ownership: 'shared' | 'personal') =>
  surface === 'operator' || ownership === 'personal' ? ('ring' as const) : ('badge' as const);

/** A Personal device names its person; a Shared one names nobody. */
export function staffDeviceFieldsValid(f: StaffDeviceFields): boolean {
  if (f.ownership === 'personal') return typeof f.personalStaffId === 'string';
  return f.personalStaffId === undefined || f.personalStaffId === null;
}
