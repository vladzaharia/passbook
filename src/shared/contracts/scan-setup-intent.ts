import { z } from 'zod';
import { SCAN_SETUP_PRESET_IDS } from '../scan-setup-preset-ids.ts';
import { IdSchema, ModeSchema, PlainLineSchema, TimestampSchema } from './common.ts';
import { ScanRoleSchema, TimeZoneSchema } from './scan.ts';
import { HoursSpanSchema, ZoneKeySchema } from './scan-access.ts';
import { OccupancyFieldsSchema } from './scan-occupancy.ts';
import { DeviceRoleSchema, StaffPinSchema } from './scanners.ts';
import {
  CreateScanningDeviceSchema,
  DevicePairingSchema,
  ScanningSessionSettingsSchema,
  ScanSurfaceChoiceSchema,
  SessionDatesSchema,
  SessionHoursSchema,
} from './scanning-sessions.ts';

/** A thing made in this request; other entries name it instead of an id. */
export const SetupRefSchema = z.string().regex(/^[a-z][a-z0-9-]{0,23}$/, 'Use a-z, 0-9 and -.');
const RefOrId = z.union([SetupRefSchema, IdSchema]);
const Spans = z.array(HoursSpanSchema).min(1).max(4);
const DateKey = SessionDatesSchema.keyType;
const Occupancy = OccupancyFieldsSchema.shape;

export const SetupPlaceSchema = z.union([
  z.strictObject({ zoneId: IdSchema }),
  z.strictObject({
    ref: SetupRefSchema,
    name: PlainLineSchema(40),
    /** Absent: made from the name. Access plans grant by this key. */
    key: ZoneKeySchema.optional(),
    inside: RefOrId.optional(),
    /** Turns on tracking. */
    max: Occupancy.capacity.unwrap().optional(),
    /** Count who is inside without a max. */
    count: z.boolean().optional(),
    /** False: people never scan out; max stay and clear-at empty the place. */
    tapOut: z.boolean().optional(),
    maxStayMinutes: Occupancy.maxStayMinutes.unwrap().optional(),
    clearAt: Occupancy.clearAt.unwrap().optional(),
  }),
]);
export type SetupPlace = z.infer<typeof SetupPlaceSchema>;

export const SetupEventSchema = z.union([
  z.strictObject({ eventId: IdSchema }),
  /** The template's upcoming events, read from its issued passes. A door naming `ref` admits them all. */
  z.strictObject({ fromTemplate: IdSchema, ref: SetupRefSchema.optional() }),
  z.strictObject({
    ref: SetupRefSchema,
    name: PlainLineSchema(80),
    templateIds: z.array(IdSchema).min(1).max(20),
    opensAt: TimestampSchema,
    closesAt: TimestampSchema,
    max: z.number().int().min(1).optional(),
    reentry: z.boolean().optional(),
  }),
]);
export type SetupEvent = z.infer<typeof SetupEventSchema>;

export const SetupLayoutSchema = z.enum(['auto', 'phone', 'operator', 'customer']);
export const SetupDeviceSchema = z.strictObject({
  /** Absent: "<door> 1", "<door> 2". */
  name: PlainLineSchema(40).optional(),
  layout: SetupLayoutSchema.optional(),
  /** Absent: derived. */
  direction: z.enum(['in', 'out', 'both']).optional(),
  reader: z.enum(['camera', 'barcode']).optional(),
});
export type SetupDevice = z.infer<typeof SetupDeviceSchema>;

export const SetupHoursSchema = z.union([
  z.literal('always'),
  z.strictObject({
    every: Spans.optional(),
    mon: Spans.optional(),
    tue: Spans.optional(),
    wed: Spans.optional(),
    thu: Spans.optional(),
    fri: Spans.optional(),
    sat: Spans.optional(),
    sun: Spans.optional(),
    closed: z.array(DateKey).max(60).optional(),
  }),
]);
export type SetupHours = z.infer<typeof SetupHoursSchema>;

export const SetupScannersSchema = z.union([
  z.strictObject({ by: z.literal('anyone'), as: z.enum(['door', 'desk']).default('door') }),
  z.strictObject({ by: z.literal('staff') }),
]);

/** Fields a preset may fill stay optional here: absent is what the preset and the defaults see. */
export const SetupDoorSchema = z.strictObject({
  name: PlainLineSchema(80),
  place: RefOrId.nullable().optional(),
  admits: z.union([
    z.strictObject({ any: z.literal(true) }),
    z.strictObject({
      templateIds: z.array(IdSchema).max(100).default([]),
      events: z.array(RefOrId).max(10).default([]),
    }),
  ]),
  /** Absent: always open. */
  hours: SetupHoursSchema.optional(),
  /** Absent: anyone, as Door. */
  scanners: SetupScannersSchema.optional(),
  /** Absent: one Automatic device. */
  devices: z.array(SetupDeviceSchema).min(1).max(10).optional(),
  more: ScanningSessionSettingsSchema.partial().optional(),
});
export type SetupDoor = z.infer<typeof SetupDoorSchema>;

export const ScanSetupPresetSchema = z.enum(SCAN_SETUP_PRESET_IDS);
export type ScanSetupPreset = z.infer<typeof ScanSetupPresetSchema>;

/** `POST /scanning-sessions/setup`: the five answers. The mode is the caller's. */
export const ScanSetupIntentSchema = z.strictObject({
  orgId: IdSchema,
  /** Fills only what is absent. */
  preset: ScanSetupPresetSchema.optional(),
  /** Absent: the org's, else UTC. */
  timeZone: TimeZoneSchema.optional(),
  places: z.array(SetupPlaceSchema).max(8).default([]),
  events: z.array(SetupEventSchema).max(10).default([]),
  staff: z
    .array(z.strictObject({ name: PlainLineSchema(40), role: ScanRoleSchema }))
    .max(50)
    .default([]),
  doors: z.array(SetupDoorSchema).min(1).max(8),
});
export type ScanSetupIntent = z.infer<typeof ScanSetupIntentSchema>;

// The plan: what apply makes, with refs in place of the ids it does not have yet.

/** A made object's ref, or an existing object's id. */
export const SetupLinkSchema = z.union([
  z.strictObject({ ref: z.string().min(1).max(64) }),
  z.strictObject({ id: IdSchema }),
]);
export type SetupLink = z.infer<typeof SetupLinkSchema>;
const PlanRef = z.string().min(1).max(64);

export const PlannedZoneSchema = OccupancyFieldsSchema.extend({
  ref: PlanRef,
  key: ZoneKeySchema,
  name: PlainLineSchema(40),
  parent: SetupLinkSchema.nullable(),
  timeZone: TimeZoneSchema.nullable(),
}).strict();
export type PlannedZone = z.infer<typeof PlannedZoneSchema>;

export const PlannedEventSchema = z.strictObject({
  ref: PlanRef,
  name: PlainLineSchema(80),
  templateIds: z.array(IdSchema).min(1).max(20),
  match: z.strictObject({ input: z.string(), values: z.array(z.string()).min(1) }).nullable(),
  opensAt: TimestampSchema,
  closesAt: TimestampSchema,
  timeZone: TimeZoneSchema,
  capacity: z.number().int().min(1).nullable(),
  reentry: z.boolean(),
});
export type PlannedEvent = z.infer<typeof PlannedEventSchema>;

export const PlannedStaffSchema = z.strictObject({
  ref: PlanRef,
  name: PlainLineSchema(40),
  role: ScanRoleSchema,
});

export const PlannedDeviceSchema = CreateScanningDeviceSchema.extend({
  ref: PlanRef,
  name: PlainLineSchema(40),
  surface: ScanSurfaceChoiceSchema,
  overrides: CreateScanningDeviceSchema.shape.overrides.unwrap(),
  /** Derived from the layout. */
  role: DeviceRoleSchema,
}).strict();
export type PlannedDevice = z.infer<typeof PlannedDeviceSchema>;

export const PlannedSessionSchema = z.strictObject({
  ref: PlanRef,
  name: PlainLineSchema(80),
  timeZone: TimeZoneSchema,
  /** Null admits any pass type. */
  accepts: z
    .strictObject({ templateIds: z.array(IdSchema).max(100), events: z.array(SetupLinkSchema) })
    .nullable(),
  zones: z.array(SetupLinkSchema).max(8),
  hours: SessionHoursSchema.nullable(),
  settings: ScanningSessionSettingsSchema.partial(),
  devices: z.array(PlannedDeviceSchema).min(1).max(10),
});
export type PlannedSession = z.infer<typeof PlannedSessionSchema>;

export const ScanSetupCheckCodeSchema = z.enum([
  'NO_EXIT',
  'NO_MANAGER',
  'NO_STAFF',
  'PLAN_MISSES_PLACE',
  'HOURS_DIFFER',
  'EVENT_NO_PASSES',
  'READER_BOTH',
  'PLACE_ON_EVENT',
  'TEST_ONLY',
  'DIRECTION_NEEDS_TRACKING',
  'OFFLINE_LIST_BLOCKED',
]);
export type ScanSetupCheckCode = z.infer<typeof ScanSetupCheckCodeSchema>;

/** One tap that resolves a check. `device` and `session` are refs or ids. */
export const ScanSetupFixSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('device_direction'),
    device: z.string(),
    direction: z.enum(['in', 'both']),
  }),
  z.strictObject({
    kind: z.literal('add_device'),
    session: z.string(),
    direction: z.literal('out'),
  }),
  z.strictObject({ kind: z.literal('add_staff'), role: z.literal('manager') }),
  z.strictObject({ kind: z.literal('remove_place'), session: z.string() }),
  z.strictObject({ kind: z.literal('track_in_out'), session: z.string() }),
  z.strictObject({ kind: z.literal('open_template'), templateId: IdSchema }),
]);
export type ScanSetupFix = z.infer<typeof ScanSetupFixSchema>;

export const ScanSetupCheckSchema = z.object({
  code: ScanSetupCheckCodeSchema,
  /** `error` stops apply. */
  level: z.enum(['error', 'warn', 'info']),
  /** A key of `SCAN_SETUP_COPY.checks`; `params` fill its `{name}` marks. */
  message: z.string(),
  params: z.record(z.string(), z.string()).optional(),
  /** The session (door) the check is about: a ref in a plan, an id on a live session. */
  door: z.string().optional(),
  subject: z
    .object({
      kind: z.enum(['session', 'device', 'zone', 'event', 'template', 'staff']),
      ref: z.string(),
    })
    .optional(),
  fix: ScanSetupFixSchema.optional(),
});
export type ScanSetupCheck = z.infer<typeof ScanSetupCheckSchema>;

/** The `dryRun` answer. No ids for new objects, no pairing, no PINs. */
export const ScanSetupPlanSchema = z.strictObject({
  mode: ModeSchema,
  timeZone: TimeZoneSchema,
  preset: ScanSetupPresetSchema.nullable(),
  zones: z.array(PlannedZoneSchema).max(8),
  events: z.array(PlannedEventSchema).max(10),
  staff: z.array(PlannedStaffSchema).max(50),
  sessions: z.array(PlannedSessionSchema).min(1).max(8),
  checks: z.array(ScanSetupCheckSchema),
});
export type ScanSetupPlan = z.infer<typeof ScanSetupPlanSchema>;

const made = { id: IdSchema, ref: z.string().nullable(), name: z.string(), created: z.boolean() };
/** The apply answer. PINs appear once; a replay carries none. */
export const ScanSetupResultSchema = z.object({
  replayed: z.boolean(),
  mode: ModeSchema,
  sessions: z.array(
    z.object({
      id: IdSchema,
      ref: z.string(),
      name: z.string(),
      devices: z.array(
        z.object({ id: IdSchema, name: z.string(), pairing: DevicePairingSchema.nullable() }),
      ),
    }),
  ),
  /** True on a replay whose pairing codes had expired: new ones are in `sessions`. */
  pairingReissued: z.boolean().default(false),
  zones: z.array(z.object(made)),
  events: z.array(z.object(made)),
  staff: z.array(
    z.object({
      id: IdSchema,
      name: z.string(),
      role: ScanRoleSchema,
      pin: StaffPinSchema.shape.pin.nullable(),
    }),
  ),
  checks: z.array(ScanSetupCheckSchema),
});
export type ScanSetupResult = z.infer<typeof ScanSetupResultSchema>;

/** What `POST /scanning-sessions/setup` answers: the result, or with `dryRun` the plan. */
export const ScanSetupAnswerSchema = z.union([ScanSetupResultSchema, ScanSetupPlanSchema]);
