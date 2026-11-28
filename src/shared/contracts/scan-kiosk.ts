import { z } from 'zod';
import { IdSchema, ModeSchema, PlainLineSchema, TimestampSchema } from './common.ts';
import { GuestCodeInputSchema } from './guest-codes.ts';
import { NfcReaderSettingsSchema, NfcReaderStatusSchema } from './nfc-reader.ts';
import { ScanPinSchema, ScanRoleSchema } from './scan.ts';
import { AgreementAcceptanceInputSchema, KioskAgreementTextSchema } from './scan-agreements.ts';
import { KioskHostSchema } from './scan-hosts.ts';
import { SessionHoursSchema } from './scanning-sessions.ts';

// Entitlement gates (added by billing package E15, not here): `scanning.selfCheckIn` for a kiosk,
// `scanning.kioskWalkIn` for `walkIn` and agreements. The server enforces them with `requireEntitled`.

export const KioskFindMeKindSchema = z.enum(['name_phone', 'email', 'member']);
export const KioskDirectionSchema = z.enum(['in', 'out', 'both']);
export const KioskPresetIdSchema = z.enum([
  'gym_front_door',
  'office_lobby',
  'event_entry',
  'museum',
  'coworking',
  'clinic',
  'club',
  'campus',
  'box_office',
]);
export const KioskWalkInFieldSchema = z.enum([
  'firstName',
  'lastName',
  'email',
  'phone',
  'company',
  'visiting',
  'news',
]);
export const KioskCameraSchema = z.enum(['unknown', 'available', 'unavailable']);
/** Default idle times: warn, then reset. */
const IdleSchema = z
  .strictObject({
    warnS: z.number().int().min(5).max(120),
    resetS: z.number().int().min(15).max(300),
  })
  .refine((i) => i.warnS < i.resetS, 'Warn before the reset.');
const WalkInSettingsSchema = z.strictObject({
  /** One of the session's accepted templates (K-D17). */
  templateId: IdSchema,
  fields: z
    .array(z.strictObject({ key: KioskWalkInFieldSchema, required: z.boolean() }))
    .min(2)
    .max(7),
  agreementIds: z.array(IdSchema).max(5),
  /** Email the picked host (`scan_hosts`) when the guest arrives. */
  emailHost: z.boolean(),
  handoff: z.enum(['qr', 'email', 'both']),
});
const CidrSchema = z
  .string()
  .max(50)
  .regex(/^[0-9a-fA-F:.]+\/\d{1,3}$/, 'Use a range like 203.0.113.0/24.');

/** `scanners.settings.kiosk` (K-D3): only on a kiosk device. */
export const KioskDeviceSettingsSchema = z.strictObject({
  entries: z.strictObject({
    pass: z.boolean(),
    findMe: z.boolean(),
    code: z.boolean(),
    walkIn: z.boolean(),
    leaving: z.boolean(),
  }),
  findMeKinds: z.array(KioskFindMeKindSchema).max(3),
  direction: KioskDirectionSchema,
  /** The session's hours when null, else the kiosk's own. */
  hours: SessionHoursSchema.nullable(),
  /** When help rings staff. Null: the same as `hours`. */
  staffedHours: SessionHoursSchema.nullable(),
  idle: IdleSchema,
  help: z.strictObject({ unstaffedText: PlainLineSchema(80) }),
  walkIn: WalkInSettingsSchema.nullable(),
  /** Lowest role that may exit or pause from the kiosk (default desk). */
  kioskExitRole: ScanRoleSchema,
  /** Lowest role that may admit anyway from the kiosk (default door). */
  kioskOverrideRole: ScanRoleSchema,
  network: z.strictObject({ cidrs: z.array(CidrSchema).max(20) }),
  /** Never longer than the pass retention; null: equal to it. */
  signatureRetentionDays: z.number().int().min(1).max(3650).nullable(),
  presetId: KioskPresetIdSchema.nullable(),
  /** The external NFC reader (NR0): off for a kiosk unless the admin turns it on. */
  nfcReader: NfcReaderSettingsSchema,
});
export type KioskDeviceSettings = z.infer<typeof KioskDeviceSettingsSchema>;
export const KioskCreateSchema = z.strictObject({
  deviceRole: z.literal('kiosk'),
  name: PlainLineSchema(80).optional(),
  kiosk: KioskDeviceSettingsSchema,
});
export const KioskPatchSchema = z.strictObject({ kiosk: KioskDeviceSettingsSchema.partial() });

/** The four guidance lines the kiosk may show under a refusal (`CUSTOMER_REASON_SUB`). */
export const KioskSubSchema = z.enum([
  'capacity_full',
  'outside_hours',
  'guest_expired',
  'still_inside',
]);
export const KioskScreenSchema = z.enum([
  'welcome',
  'goodbye',
  'choose',
  'partial',
  'see_desk',
  'locked',
  'paused',
  'closed',
]);
/** What a kiosk is ever sent: no reason, id, count (but `room`), full email or last name. */
export const KioskViewSchema = z.strictObject({
  screen: KioskScreenSchema,
  /** First name only. */
  greet: z.string().min(1).max(24).optional(),
  card: z.strictObject({ label: z.string().max(40), band: z.enum(['in', 'out']) }).optional(),
  reward: z.strictObject({ label: z.string().max(40) }).optional(),
  rows: z
    .array(
      z.strictObject({
        handle: z.string().min(1).max(128),
        firstName: z.string().min(1).max(24),
        hint: z.string().max(24),
      }),
    )
    .max(4)
    .optional(),
  /** Partial groups only. */
  room: z.number().int().min(1).max(999).optional(),
  sub: KioskSubSchema.optional(),
  /** Fills `{when}` of the `outside_hours` sub, in the session or org zone. */
  subWhen: z.string().max(40).optional(),
  hostNotified: z.boolean().optional(),
  handoff: z.strictObject({ url: z.string().max(512), expiresAt: TimestampSchema }).optional(),
});
export type KioskView = z.infer<typeof KioskViewSchema>;

/**
 * `GET /scan/kiosk/config`: the privacy boundary. Settings the screen needs, the agreement words,
 * and nothing else. No staff name, role, reason, CIDR, retention, template id or member data.
 */
export const KioskConfigSchema = z.strictObject({
  /** The device's name, such as "Kiosk 1", for the staff PIN card. */
  name: PlainLineSchema(80),
  mode: ModeSchema,
  timeZone: z.string().max(64),
  /** Reloads the kiosk when it changes (the `0052` trigger). */
  configEpoch: z.number().int().min(0),
  entries: KioskDeviceSettingsSchema.shape.entries,
  findMeKinds: KioskDeviceSettingsSchema.shape.findMeKinds,
  direction: KioskDirectionSchema,
  hours: SessionHoursSchema.nullable(),
  staffedHours: SessionHoursSchema.nullable(),
  idle: KioskDeviceSettingsSchema.shape.idle,
  help: KioskDeviceSettingsSchema.shape.help,
  walkIn: z
    .strictObject({
      fields: WalkInSettingsSchema.shape.fields,
      handoff: WalkInSettingsSchema.shape.handoff,
      agreements: z.array(KioskAgreementTextSchema).max(5),
    })
    .nullable(),
  /** The host picker shows. */
  hostPicker: z.boolean(),
  /** A Connections endpoint takes `help_request.opened` (K-D20). */
  helpConnected: z.boolean(),
  nfcReader: NfcReaderSettingsSchema,
  /** Higher than the device's stored one: forget the pinned reader. */
  readerEpoch: z.number().int().min(0),
});
export type KioskConfig = z.infer<typeof KioskConfigSchema>;

/** `POST /scan/kiosk/heartbeat` every 30 s. The screen is the current one or `home`; never PII. */
export const KioskHeartbeatSchema = z.strictObject({
  screen: z.union([KioskScreenSchema, z.literal('home')]),
  /** Chromium only; an iPad sends none. */
  battery: z
    .strictObject({ pct: z.number().int().min(0).max(100), charging: z.boolean() })
    .optional(),
  camera: KioskCameraSchema,
  /** The reader's state; the server stamps `reportedAt` and stores it in `scan_kiosk_status.nfc_reader`. */
  nfcReader: NfcReaderStatusSchema.omit({ reportedAt: true }).optional(),
});
export const KioskHeartbeatResultSchema = z.strictObject({
  configEpoch: z.number().int().min(0),
  paused: z.boolean(),
});

/** Bodies, each answered with a `KioskView` padded to a 400 ms floor. */
export const KioskLookupSchema = z.strictObject({
  kind: KioskFindMeKindSchema,
  value: z.string().trim().min(1).max(254),
  direction: z.literal('out').optional(),
});
export const KioskCodeSchema = z.strictObject({ code: GuestCodeInputSchema });
export const KioskConfirmSchema = z.strictObject({
  handles: z.array(z.string().min(1).max(128)).min(1).max(8),
  /** Redeems a `kiosk_admit` grant (K-D18). */
  approval: z.strictObject({ requestId: IdSchema }).optional(),
});
const DetailSchema = z.strictObject({
  firstName: PlainLineSchema(24),
  lastName: PlainLineSchema(40),
  email: z.string().trim().max(254),
  phone: PlainLineSchema(24).optional(),
  company: PlainLineSchema(60).optional(),
  news: z.boolean().optional(),
});
export const KioskWalkInSchema = z.strictObject({
  details: DetailSchema,
  acceptances: z.array(AgreementAcceptanceInputSchema).max(5),
  hostId: KioskHostSchema.shape.id.optional(),
  /** Dedupes retries only; a repeat email still gets a new pass (K-D9). */
  idempotencyKey: z.string().min(8).max(64),
});
export const KioskHandoffRevokeParamsSchema = z.strictObject({ id: IdSchema });
export const KioskStaffAdmitSchema = z.union([
  z.strictObject({ lastRefusal: z.literal(true) }),
  z.strictObject({ handles: z.array(z.string().min(1).max(128)).min(1).max(8) }),
]);
/** Exit needs a fresh PIN with the binding. */
export const KioskStaffExitSchema = z.strictObject({ pin: ScanPinSchema });

/** The only device endpoints a kiosk may call (K-D2); anything else is 403 `KIOSK_NOT_ALLOWED`. */
export const KIOSK_ALLOWED_ENDPOINTS: readonly (readonly [method: string, path: string])[] = [
  ['GET', '/scan/kiosk/config'],
  ['POST', '/scan/kiosk/heartbeat'],
  ['POST', '/scan'],
  ['POST', '/scan/kiosk/lookup'],
  ['POST', '/scan/kiosk/code'],
  ['POST', '/scan/kiosk/confirm'],
  ['GET', '/scan/kiosk/hosts'],
  ['POST', '/scan/kiosk/walk-in'],
  ['POST', '/scan/kiosk/handoff/{id}/revoke'],
  ['POST', '/staff/pin'],
  ['DELETE', '/staff'],
  ['POST', '/scan/kiosk/staff/admit'],
  ['POST', '/scan/kiosk/staff/pause'],
  ['POST', '/scan/kiosk/staff/resume'],
  ['POST', '/scan/kiosk/staff/exit'],
  ['POST', '/scan/help'],
  ['POST', '/scan/help/{id}/cancel'],
  ['GET', '/scan/help/{id}'],
];
/** Kiosk-only codes. `FEATURE_NOT_INCLUDED` is the platform's. `KIOSK_NOT_ALLOWED` is in `scan-help.ts`. */
export const KIOSK_ERROR_STATUS = { KIOSK_NETWORK: 403, KIOSK_TOO_MANY_LOOKUPS: 429 } as const;

/** `GET …/kiosk-status`: the live mirror for admin. */
export const KioskStatusSchema = z.strictObject({
  screen: z.union([KioskScreenSchema, z.literal('home')]).nullable(),
  at: TimestampSchema.nullable(),
  battery: z
    .strictObject({ pct: z.number().int().min(0).max(100), charging: z.boolean() })
    .nullable(),
  camera: KioskCameraSchema.nullable(),
  nfcReader: NfcReaderStatusSchema.nullable(),
  /** Today in the session or org zone, by path (`scans.via`). */
  today: z.strictObject({
    pass: z.number().int().min(0),
    findMe: z.number().int().min(0),
    code: z.number().int().min(0),
    walkIn: z.number().int().min(0),
    group: z.number().int().min(0),
    leaving: z.number().int().min(0),
  }),
  help: z.strictObject({
    opened: z.number().int().min(0),
    medianAnswerS: z.number().int().min(0).nullable(),
  }),
  misses: z.strictObject({ today: z.number().int().min(0), locked: z.boolean() }),
});
export type KioskStatus = z.infer<typeof KioskStatusSchema>;
