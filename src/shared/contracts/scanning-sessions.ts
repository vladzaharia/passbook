import { z } from 'zod';
import {
  IdSchema,
  ModeSchema,
  PageQuerySchema,
  PlainLineSchema,
  pageOf,
  TimestampSchema,
} from './common.ts';
import { SessionTagRulesSchema } from './nfc-tags.ts';
import {
  ScanApprovalSchema,
  ScannerSettingsSchema,
  ScanReasonSchema,
  ScanRecordMethodSchema,
  TimeZoneSchema,
} from './scan.ts';
import { HoursSpanSchema, SESSION_DEVICE_CAP, ZoneIdsSchema } from './scan-access.ts';
import { NativeHardwareEntrySchema, ReportedHardwareSchema } from './scan-hardware.ts';
import { AdmitsSchema } from './scanners.ts';

/** Layout and sign-in method are independent: an admin is another device in the session. */
export const ScanSurfaceSchema = z.enum(['phone', 'operator', 'desk', 'customer']);
export type ScanSurface = z.infer<typeof ScanSurfaceSchema>;
export const ScanSurfaceChoiceSchema = z.enum(['auto', 'phone', 'operator', 'desk', 'customer']);
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
  .extend({ follows: z.array(IdSchema).min(1).max(SESSION_DEVICE_CAP).optional() }) // absent: all
  .partial()
  .strict();
export type ScanDeviceOverrides = z.infer<typeof ScanDeviceOverridesSchema>;
/** What a customer screen says. Each field is optional; the defaults are in `copy/scan-customer.ts`. */
export const SessionCustomerSettingsSchema = z.strictObject({
  welcome: PlainLineSchema(40).optional(),
  refusedLine: PlainLineSchema(40).optional(),
  greet: z.boolean().optional(),
  showReady: z.boolean().optional(),
  showDraft: z.boolean().optional(),
});
export type SessionCustomerSettings = z.infer<typeof SessionCustomerSettingsSchema>;
export const ScanningSessionSettingsSchema = ScannerSettingsSchema.extend({
  customer: SessionCustomerSettingsSchema.optional(),
  /** The assign rights of every device, plus the session's tag level (absent: the org's). */
  tags: SessionTagRulesSchema.optional(),
});
export const ScanningSessionStatusSchema = z.enum(['active', 'paused', 'ended']);
const DateKeySchema = z.string().refine((v) => {
  const [y = 0, m = 0, d = 0] = v.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}, 'Use a date like 2026-12-25.');
/** Dated exceptions, in the session's zone: no spans is closed all day, else that date's own hours. */
const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
/** Sorted by start, none overlapping (an end at or before its start runs past midnight). */
function orderedSpans(spans: string[]): boolean {
  let prevEnd = -1;
  for (const s of spans) {
    const start = minutesOf(s);
    const end = minutesOf(s.slice(6));
    if (start < prevEnd) return false;
    prevEnd = end <= start ? end + 1440 : end;
  }
  return true;
}
export const SessionDatesSchema = z
  .record(
    DateKeySchema,
    z.array(HoursSpanSchema).max(4).refine(orderedSpans, 'Sort spans by start; none overlap.'),
  )
  .refine((dates) => Object.keys(dates).length <= 60, 'At most 60 closed dates.');
const DaySpans = z.array(HoursSpanSchema).min(1).max(4).optional();
/** When an active session scans, by the session's own clock. At least one span, none empty. */
export const SessionHoursSchema = z
  .strictObject({
    mon: DaySpans,
    tue: DaySpans,
    wed: DaySpans,
    thu: DaySpans,
    fri: DaySpans,
    sat: DaySpans,
    sun: DaySpans,
    dates: SessionDatesSchema.optional(),
  })
  .refine((hours) => {
    const { dates, ...week } = hours;
    const weekly = Object.values(week).flat();
    const spans = [...weekly, ...Object.values(dates ?? {}).flat()];
    return weekly.length > 0 && spans.every((s) => s !== undefined && s.slice(0, 5) !== s.slice(6));
  }, 'Add at least one span; start and end differ.');
export type SessionHours = z.infer<typeof SessionHoursSchema>;
/** A manual override of the hours until `until` (an instant). */
export const SessionHoldSchema = z.strictObject({
  state: z.enum(['open', 'closed']),
  until: TimestampSchema,
});
export type SessionHold = z.infer<typeof SessionHoldSchema>;
/** Computed by the server at read time; ignores `status`, which stays the master switch. */
export const SessionWindowSchema = z.object({
  open: z.boolean(),
  by: z.enum(['always', 'hours', 'hold']),
  opensAt: TimestampSchema.nullable(),
  closesAt: TimestampSchema.nullable(),
});
export type SessionWindow = z.infer<typeof SessionWindowSchema>;
export const ScanningSessionSchema = z.object({
  id: IdSchema,
  orgId: IdSchema,
  orgName: z.string(),
  mode: ModeSchema,
  name: PlainLineSchema(80),
  status: ScanningSessionStatusSchema,
  accepts: AdmitsSchema.nullable(),
  settings: ScanningSessionSettingsSchema,
  /** Access zones this session checks. Absent from servers that predate zones. */
  zoneIds: ZoneIdsSchema.optional(),
  timeZone: TimeZoneSchema,
  /** Absent from servers that predate session hours; null: always open. */
  hours: SessionHoursSchema.nullable().optional(),
  /** The stored schedule no longer parses, so the session stays closed until it is saved again. */
  hoursInvalid: z.literal(true).optional(),
  /** The hold in force, if any. */
  hold: SessionHoldSchema.nullable().optional(),
  window: SessionWindowSchema.optional(),
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
  accepts: AdmitsSchema.nullable().default(null),
  settings: ScanningSessionSettingsSchema.partial().optional(),
  zoneIds: ZoneIdsSchema.optional(),
  hours: SessionHoursSchema.nullable().optional(),
});
/** No defaults: a field that is absent is left as it is (a name-only edit keeps scope and settings). */
export const UpdateScanningSessionSchema = z.strictObject({
  name: PlainLineSchema(80).optional(),
  timeZone: TimeZoneSchema.optional(),
  accepts: AdmitsSchema.nullable().optional(),
  settings: ScanningSessionSettingsSchema.partial().optional(),
  zoneIds: ZoneIdsSchema.optional(),
  hours: SessionHoursSchema.nullable().optional(),
  status: ScanningSessionStatusSchema.optional(),
  /** With status `ended`: revoke every device of the session in the same write. Default false. */
  removeDevices: z.boolean().optional(),
  revision: TimestampSchema.optional(),
});
/** Close now, Open now (until at most 24 h ahead; default by the schedule) or Back to hours. */
export const SessionHoldRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('close'), revision: TimestampSchema.optional() }),
  z.strictObject({
    action: z.literal('open'),
    until: TimestampSchema.optional(),
    revision: TimestampSchema.optional(),
  }),
  z.strictObject({ action: z.literal('clear'), revision: TimestampSchema.optional() }),
]);
/** A Manager opens the session early from the scanner: signed in as one, or with a manager code. */
export const ScanSessionOpenNowSchema = z.strictObject({
  until: TimestampSchema.optional(),
  approval: ScanApprovalSchema.optional(),
});
export const ScanSessionOpenedSchema = z.object({ window: SessionWindowSchema });
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
        /** The scan to undo or let in: the row's id when the viewer may see its pass, else null. */
        scanId: IdSchema.nullable().default(null),
        reason: ScanReasonSchema.nullable().default(null),
        /** Who was signed in on the device. Desk and Manager viewers only. */
        staff: z.string().nullable().default(null),
        method: ScanRecordMethodSchema.nullable().default(null),
        /** The viewing device may undo this scan now: its own, inside the undo window. */
        undoable: z.boolean().default(false),
        /** Passes one group request checked in, on the group's anchor row. */
        groupSize: z.number().int().min(2).nullable().default(null),
      }),
    )
    .max(50),
});
export const ScanningSessionDetailSchema = ScanningSessionSchema.extend({
  devices: z.array(ScanningDeviceSchema),
  activity: SessionActivitySchema.shape.items.default([]),
});
export const CreateScanningDeviceSchema = z.strictObject({
  /** Absent: the server picks a free name from the session's. */
  name: PlainLineSchema(40).optional(),
  surface: ScanSurfaceChoiceSchema.default('auto'),
  overrides: ScanDeviceOverridesSchema.default({}),
});
/** No defaults: a name-only edit keeps the surface, hence the device role, and the overrides. */
export const UpdateScanningDeviceSchema = z.strictObject({
  name: PlainLineSchema(40).optional(),
  surface: ScanSurfaceChoiceSchema.optional(),
  overrides: ScanDeviceOverridesSchema.optional(),
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
  device: ScanningDeviceSchema.extend({
    overrides: ScanDeviceOverridesSchema.omit({ follows: true }),
  }),
});
export type ScanWorkspace = z.infer<typeof ScanWorkspaceSchema>;
export const ReportScanDeviceSchema = z.object({
  capabilities: ScanDeviceCapabilitiesSchema,
  scope: z.object({ orgId: IdSchema, setupId: IdSchema, timeZone: TimeZoneSchema }).optional(),
});
