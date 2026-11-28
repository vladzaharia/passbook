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
import {
  CreatableDeviceRoleSchema,
  ReportedScanDeviceCapabilitiesSchema,
  ScanDeviceCapabilitiesSchema,
  ScanSurfaceChoiceSchema,
  ScanSurfaceSchema,
  StaffDeviceFieldsSchema,
  staffDeviceFieldsValid,
} from './scan-device.ts';
import { AdmitsSchema, DeviceRoleSchema } from './scanners.ts';

export {
  CreatableDeviceRoleSchema,
  type NativeScannerCapabilities,
  NativeScannerCapabilitiesSchema,
  type ReportedScanDeviceCapabilities,
  ReportedScanDeviceCapabilitiesSchema,
  type ScanDeviceCapabilities,
  ScanDeviceCapabilitiesSchema,
  type ScanSurface,
  type ScanSurfaceChoice,
  ScanSurfaceChoiceSchema,
  ScanSurfaceSchema,
} from './scan-device.ts';

/** Admission, staff rights, accepted passes and time zone always belong to the session. */
export const ScanDeviceOverridesSchema = ScannerSettingsSchema.pick({
  flow: true,
  reader: true,
  direction: true,
  lookup: true,
  showPhoto: true,
  monitorAudience: true,
  appearance: true,
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
  deviceRole: DeviceRoleSchema,
  /** A Staff device's layout choice and what it resolved to; null on every other kind. */
  surface: ScanSurfaceChoiceSchema.nullable(),
  effectiveSurface: ScanSurfaceSchema.nullable(),
  ...StaffDeviceFieldsSchema.shape,
  overrides: ScanDeviceOverridesSchema,
  settings: ScannerSettingsSchema,
  capabilities: ScanDeviceCapabilitiesSchema.nullable(),
  reportedAt: TimestampSchema.nullable(),
  paired: z.boolean(),
  online: z.boolean(),
  revoked: z.boolean(),
  lastSeenAt: TimestampSchema.nullable(),
  updatedAt: TimestampSchema,
  configRevision: TimestampSchema,
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
const STAFF_KEYS = ['surface', ...Object.keys(StaffDeviceFieldsSchema.shape)];
const staffOnly = (d: Record<string, unknown>) =>
  d.deviceRole === 'scan' || STAFF_KEYS.every((key) => d[key] === undefined);
const STAFF_ONLY = 'A layout, owner, sign-in ceiling, alerts and coverage are for a Staff device.';
const PERSONAL = 'A Personal device names its person; a Shared one names nobody.';
export const CreateScanningDeviceSchema = z
  .strictObject({
    /** Absent: the server picks a free name from the session's. */
    name: PlainLineSchema(40).optional(),
    /** Absent: a Staff device. */
    deviceRole: CreatableDeviceRoleSchema.default('scan'),
    /** A Staff device only. Absent: `auto`. */
    surface: ScanSurfaceChoiceSchema.optional(),
    ...StaffDeviceFieldsSchema.shape,
    overrides: ScanDeviceOverridesSchema.default({}),
  })
  .refine(staffOnly, STAFF_ONLY)
  .refine(staffDeviceFieldsValid, PERSONAL);
/** No defaults: a name-only edit keeps the kind, the layout and the overrides. The kind never changes. */
export const UpdateScanningDeviceSchema = z
  .strictObject({
    name: PlainLineSchema(40).optional(),
    surface: ScanSurfaceChoiceSchema.optional(),
    ...StaffDeviceFieldsSchema.shape,
    overrides: ScanDeviceOverridesSchema.optional(),
    revision: TimestampSchema.optional(),
  })
  // The full rule needs the stored row: the server checks the merged device.
  .refine((d) => d.ownership !== 'shared' || !d.personalStaffId, PERSONAL);
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
  capabilities: ReportedScanDeviceCapabilitiesSchema,
  scope: z.object({ orgId: IdSchema, setupId: IdSchema, timeZone: TimeZoneSchema }).optional(),
});
