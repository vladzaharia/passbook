import { z } from 'zod';
import {
  IdSchema,
  ModeSchema,
  PageQuerySchema,
  PlainLineSchema,
  pageOf,
  TimestampSchema,
} from './common.ts';
import {
  ScanMethodSchema,
  ScannerSettingsSchema,
  ScanReasonSchema,
  ScanRecordKindSchema,
  ScanRecordOutcomeSchema,
  ScanRoleSchema,
  TimeZoneSchema,
} from './scan.ts';

const NoteSchema = PlainLineSchema(140);
const JsonValue = z.any();

export const ScannerKindSchema = z.enum(['device', 'terminal', 'display']);
/** What the device does now: scan, face a customer, or watch scans. A display never scans. */
export const DeviceRoleSchema = z.enum(['scan', 'customer', 'monitor']);
export const ScannerAcceptsSchema = z.union([
  z.object({ eventId: IdSchema }),
  z.object({ templateIds: z.array(IdSchema).min(1).max(20) }),
]);
export const ScannerSchema = z.object({
  id: IdSchema,
  orgId: IdSchema,
  mode: ModeSchema,
  kind: ScannerKindSchema,
  deviceRole: DeviceRoleSchema,
  name: z.string(),
  /** Null only for kind `display`. */
  accepts: ScannerAcceptsSchema.nullable(),
  settings: ScannerSettingsSchema,
  timeZone: z.string(),
  status: z.enum(['not_paired', 'paired', 'revoked']),
  online: z.boolean(),
  pairedAt: TimestampSchema.nullable(),
  pairedLabel: z.string().nullable(),
  lastSeenAt: TimestampSchema.nullable(),
  expiresAt: TimestampSchema.nullable(),
  staff: z.object({ id: IdSchema, name: z.string() }).nullable(),
  today: z.number().int(),
  createdAt: TimestampSchema,
});
export type ScannerDto = z.infer<typeof ScannerSchema>;
/** The mode comes from the console's current mode, never from the body. */
export const CreateScannerSchema = z.object({
  orgId: IdSchema,
  name: PlainLineSchema(40),
  /** Creating a display is a later stream; widening this enum is additive. */
  kind: z.enum(['device', 'terminal']),
  accepts: ScannerAcceptsSchema,
  settings: ScannerSettingsSchema.partial().optional(),
  timeZone: TimeZoneSchema,
});
export const UpdateScannerSchema = z.object({
  name: PlainLineSchema(40).optional(),
  accepts: ScannerAcceptsSchema.optional(),
  settings: ScannerSettingsSchema.partial().optional(),
});
/** `detachEvent` lets the change go through while the scanner sits on an event of the old mode. */
export const ScannerModeSchema = z.object({
  mode: ModeSchema,
  detachEvent: z.boolean().optional(),
});
/** A new scanner, plus its first pairing code when it is a browser device. */
export const CreatedScannerSchema = ScannerSchema.extend({
  pairing: z.object({ code: z.string(), url: z.string(), expiresAt: TimestampSchema }).nullable(),
});
export const ScannerSamplePassSchema = z.object({ passId: IdSchema, templateId: IdSchema });
export const ScannerListQuerySchema = PageQuerySchema.extend({
  orgId: IdSchema.optional(),
  status: z.enum(['not_paired', 'paired', 'revoked']).optional(),
  eventId: IdSchema.optional(),
  q: z.string().trim().max(80).optional(),
});
export const ScannerListSchema = pageOf(ScannerSchema);
export const ScannerPairingSchema = z.object({
  code: z.string(),
  url: z.string(),
  expiresAt: TimestampSchema,
});
export const ScannerPairingStateSchema = z.object({
  state: z.enum(['waiting', 'paired', 'expired']),
  device: z.object({ label: z.string(), at: TimestampSchema }).nullable(),
});
export const TerminalTokenSchema = z.object({ token: z.string(), expiresAt: TimestampSchema });
export const ScannerStatsSchema = z.object({
  days: z.array(
    z.object({
      day: z.string(),
      ok: z.number().int(),
      headsUp: z.number().int(),
      refused: z.number().int(),
    }),
  ),
  methods: z.record(ScanMethodSchema, z.number().int()),
  lastSeenAt: TimestampSchema.nullable(),
});

const EventMatchSchema = z.object({
  input: z.string().min(1).max(64),
  values: z.array(z.string().min(1).max(120)).min(1).max(20),
});
export const ScanEventSchema = z.object({
  id: IdSchema,
  orgId: IdSchema,
  mode: ModeSchema,
  name: z.string(),
  templateIds: z.array(IdSchema),
  match: EventMatchSchema.nullable(),
  opensAt: TimestampSchema,
  closesAt: TimestampSchema,
  timeZone: z.string(),
  capacity: z.number().int().nullable(),
  reentry: z.boolean(),
  /** The staff note. No other display field lives on an event (SA D21). */
  note: NoteSchema.nullable(),
  status: z.enum(['upcoming', 'live', 'ended', 'archived']),
  arrived: z.number().int(),
  expected: z.number().int(),
  scanners: z.number().int(),
});
export type ScanEventDto = z.infer<typeof ScanEventSchema>;
const eventFields = {
  name: PlainLineSchema(80),
  templateIds: z.array(IdSchema).min(1).max(20),
  match: EventMatchSchema.nullable().optional(),
  opensAt: TimestampSchema,
  closesAt: TimestampSchema,
  timeZone: TimeZoneSchema,
  capacity: z.number().int().min(1).nullable().optional(),
  reentry: z.boolean().optional(),
  note: NoteSchema.nullable().optional(),
};
const closesAfterOpens = (v: { opensAt?: number; closesAt?: number }) =>
  v.opensAt === undefined || v.closesAt === undefined || v.closesAt > v.opensAt;
export const CreateScanEventSchema = z
  .object({ orgId: IdSchema, ...eventFields })
  .refine(closesAfterOpens, { path: ['closesAt'], message: 'Closing must be after opening.' });
export const UpdateScanEventSchema = z
  .object(eventFields)
  .partial()
  .extend({ archived: z.boolean().optional() })
  .refine(closesAfterOpens, { path: ['closesAt'], message: 'Closing must be after opening.' });
export const ScanEventAssignSchema = z.object({ scannerIds: z.array(IdSchema).max(200) });
export const ScanEventListQuerySchema = PageQuerySchema.extend({
  orgId: IdSchema.optional(),
  status: z.enum(['upcoming', 'live', 'ended', 'archived']).optional(),
  q: z.string().trim().max(80).optional(),
});

export const ScanRecordSchema = z.object({
  id: IdSchema,
  at: TimestampSchema,
  outcome: ScanRecordOutcomeSchema,
  reason: ScanReasonSchema.nullable(),
  kind: ScanRecordKindSchema.nullable(),
  actionId: z.string().nullable(),
  actionLabel: z.string().nullable(),
  direction: z.enum(['in', 'out']).nullable(),
  passId: IdSchema.nullable(),
  passTitle: z.string().nullable(),
  templateId: IdSchema.nullable(),
  templateName: z.string().nullable(),
  eventId: IdSchema.nullable(),
  eventName: z.string().nullable(),
  scannerId: IdSchema.nullable(),
  scannerName: z.string().nullable(),
  staffId: IdSchema.nullable(),
  staffName: z.string().nullable(),
  approvedBy: z.string().nullable(),
  method: ScanMethodSchema,
  amount: z.number().nullable(),
  before: JsonValue.nullable(),
  after: JsonValue.nullable(),
  passVersion: z.number().int().nullable(),
  override: z.boolean(),
  offline: z.boolean(),
  actor: z.object({ type: z.enum(['scanner', 'user']), id: z.string() }),
  undoneAt: TimestampSchema.nullable(),
  undoneBy: z.string().nullable(),
  undoes: IdSchema.nullable(),
});
export type ScanRecordDto = z.infer<typeof ScanRecordSchema>;
export const ScanEventLiveSchema = z.object({
  arrived: z.number().int(),
  inside: z.number().int().nullable(),
  expected: z.number().int(),
  capacity: z.number().int().nullable(),
  perMinute: z
    .array(
      z.object({
        at: TimestampSchema,
        ok: z.number().int(),
        headsUp: z.number().int(),
        refused: z.number().int(),
      }),
    )
    .max(30),
  scanners: z.array(
    z.object({
      id: IdSchema,
      name: z.string(),
      ok: z.number().int(),
      lastScanAt: TimestampSchema.nullable(),
      online: z.boolean(),
    }),
  ),
  reasons: z.array(z.object({ reason: ScanReasonSchema, count: z.number().int() })),
  latest: z.array(ScanRecordSchema).max(20),
});

export const ScanStaffSchema = z.object({
  id: IdSchema,
  orgId: IdSchema,
  name: z.string(),
  role: ScanRoleSchema,
  pinSetAt: TimestampSchema,
  locked: z.boolean(),
  disabledAt: TimestampSchema.nullable(),
  today: z.number().int(),
  lastScan: z.object({ at: TimestampSchema, scannerName: z.string() }).nullable(),
});
export const CreateScanStaffSchema = z.object({
  orgId: IdSchema,
  name: PlainLineSchema(40),
  role: ScanRoleSchema,
});
export const UpdateScanStaffSchema = z.object({
  name: PlainLineSchema(40).optional(),
  role: ScanRoleSchema.optional(),
  disabled: z.boolean().optional(),
});
/** Shown once, when a person is added or a PIN is reset. */
export const StaffPinSchema = z.object({ pin: z.string().regex(/^\d{6}$/) });

export const ScanListQuerySchema = PageQuerySchema.extend({
  orgId: IdSchema.optional(),
  scannerId: IdSchema.optional(),
  staffId: IdSchema.optional(),
  eventId: IdSchema.optional(),
  passId: IdSchema.optional(),
  outcome: ScanRecordOutcomeSchema.optional(),
  reason: ScanReasonSchema.optional(),
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const ScanRecordListSchema = pageOf(ScanRecordSchema);
/** For API keys with `scans:read`: no pass titles, no staff names. */
export const ScanFeedRowSchema = z.object({
  id: IdSchema,
  at: TimestampSchema,
  passId: IdSchema.nullable(),
  externalId: z.string().nullable(),
  templateId: IdSchema.nullable(),
  eventId: IdSchema.nullable(),
  actionId: z.string().nullable(),
  kind: ScanRecordKindSchema.nullable(),
  outcome: ScanRecordOutcomeSchema,
  reason: ScanReasonSchema.nullable(),
  amount: z.number().nullable(),
  before: JsonValue.nullable(),
  after: JsonValue.nullable(),
  method: ScanMethodSchema,
  scannerId: IdSchema.nullable(),
  scannerName: z.string().nullable(),
  undoneAt: TimestampSchema.nullable(),
});
export const ScanFeedSchema = pageOf(ScanFeedRowSchema);
