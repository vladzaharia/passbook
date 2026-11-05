import { z } from 'zod';
import { IdSchema, JsonSchema, ModeSchema, TimestampSchema } from './common.ts';
import { ScanDisplaySchema } from './scan-display.ts';

/** Idempotency keys: UUIDv7, made by the client. */
export const UuidV7Schema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

/** An IANA zone name the runtime knows. */
export const TimeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((zone) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, 'Use an IANA time zone, such as Europe/Berlin.');

export const ScanMethodSchema = z.enum(['camera', 'wedge', 'nfc', 'manual']);
export type ScanMethod = z.infer<typeof ScanMethodSchema>;
export const ScanActionKindSchema = z.enum(['check_in', 'add', 'take', 'set', 'use_up']);
export const ScanRoleSchema = z.enum(['door', 'desk', 'manager']);
export type ScanRole = z.infer<typeof ScanRoleSchema>;
export const ScanDirectionSchema = z.enum(['in', 'out']);
export const CodeFormatSchema = z.enum([
  'qr',
  'pdf417',
  'aztec',
  'code128',
  'code39',
  'codabar',
  'ean13',
  'itf',
]);
export const ScanOutcomeKindSchema = z.enum(['ok', 'heads_up', 'refused', 'ready']);
export type ScanOutcomeKind = z.infer<typeof ScanOutcomeKindSchema>;
/** What `scans.outcome` can hold: a stored scan is never `ready`. */
export const ScanRecordOutcomeSchema = z.enum(['ok', 'heads_up', 'refused']);
/** What `scans.action_kind` can hold: the action kinds, and `undo` for the row an undo writes. */
export const ScanRecordKindSchema = z.enum([...ScanActionKindSchema.options, 'undo']);

/** Wire reasons. The client-only ones (network, timeout, ...) live in `src/web/scan/machine/types.ts`. */
export const SCAN_REFUSED_REASONS = [
  'not_found',
  'ambiguous',
  'test_pass',
  'live_pass',
  'not_accepted',
  'wrong_event',
  'removed',
  'voided',
  'expired',
  'no_balance',
  'managed_elsewhere',
  'limit_reached',
  'zone_not_included',
  'outside_hours',
  'guest_expired',
  'guest_visits_used',
  'suspended',
] as const;
export const SCAN_HEADS_UP_REASONS = [
  'already_done',
  'cooldown',
  'not_yet_valid',
  'ended',
  'capacity_full',
  'check_required',
  'needs_approval',
  'stale',
  'in_progress',
] as const;
export const ScanReasonSchema = z.enum([
  ...SCAN_REFUSED_REASONS,
  ...SCAN_HEADS_UP_REASONS,
  'choose',
]);
export type ScanReason = z.infer<typeof ScanReasonSchema>;

export const ScannerSettingsSchema = z.object({
  flow: z.enum(['auto', 'choose']),
  defaultActionId: z.string().min(1).max(32).nullable(),
  roleWithoutSignIn: z.enum(['door', 'desk']),
  staffSignIn: z.boolean(),
  letInAgain: z.enum(['anyone', 'manager', 'never']),
  reader: z.enum(['none', 'barcode', 'nfc']),
  lookup: z.boolean(),
  offline: z.boolean(),
  dailyAmount: z.number().int().min(1).max(10_000_000).nullable(),
});
export type ScannerSettings = z.infer<typeof ScannerSettingsSchema>;

export const ScanInputSchema = z.union([
  z.object({ code: z.string().min(1).max(1024), method: ScanMethodSchema }),
  z.object({ passId: IdSchema, method: z.literal('manual') }),
]);
export type ScanInput = z.infer<typeof ScanInputSchema>;

/**
 * An admin names the org, and optionally the event or templates, per request: in the JSON body's
 * `scope`, or on a GET as `?orgId&eventId&templateIds=a,b&timeZone`. The asset route, which an
 * `<img>` loads, takes the same query next to `g`. A scanner never sends it.
 */
export const ScanAdminScopeSchema = z.object({
  orgId: IdSchema,
  eventId: IdSchema.optional(),
  templateIds: z.array(IdSchema).max(20).optional(),
  timeZone: TimeZoneSchema,
});
/** What an Access card's plan says about a verdict. Null on every other template. */
export const ScanAccessSchema = z.object({
  plan: z.object({ id: z.string(), label: z.string(), kind: z.enum(['always', 'timed', 'guest']) }),
  zone: z.object({ id: IdSchema, name: z.string() }).nullable(),
  closesAt: TimestampSchema.nullable(),
  nextOpenAt: TimestampSchema.nullable(),
  visits: z.object({ used: z.number().int(), limit: z.number().int().nullable() }).nullable(),
  visit: z.boolean(),
  /** The deciding zone's clock; the client formats {time} and {when} with it. */
  timeZone: TimeZoneSchema,
});
export type ScanAccess = z.infer<typeof ScanAccessSchema>;
export const ScanApprovalSchema = z.object({ staffId: IdSchema, pin: z.string().regex(/^\d{6}$/) });

const request = {
  idempotencyKey: UuidV7Schema,
  input: ScanInputSchema,
  clientTs: TimestampSchema,
  dayStart: TimestampSchema.optional(),
  scope: ScanAdminScopeSchema.optional(),
};
export const ScanResolveRequestSchema = z.strictObject(request);
export const ScanActRequestSchema = z.strictObject({
  ...request,
  actionId: z.union([z.string().min(1).max(32), z.literal('auto')]),
  amount: z.number().finite().optional(),
  value: JsonSchema.optional(),
  direction: ScanDirectionSchema.optional(),
  /** The heads-up scan being overridden. */
  overrideOf: IdSchema.optional(),
  /** Stop flags acknowledged. */
  confirmed: z.boolean().optional(),
  /** For `set`: the card's version. */
  expectedVersion: z.number().int().optional(),
  group: z.literal('bundle').optional(),
  approval: ScanApprovalSchema.optional(),
});
/** An admin names the org in `scope`, as on any scan call. A scanner never sends it. */
export const ScanUndoRequestSchema = z.strictObject({
  idempotencyKey: UuidV7Schema,
  scope: ScanAdminScopeSchema.optional(),
  approval: ScanApprovalSchema.optional(),
});

export const ScanPreviousSchema = z.object({
  scanId: IdSchema,
  at: TimestampSchema,
  scannerName: z.string(),
  staffName: z.string().nullable(),
  actionLabel: z.string(),
  override: z.boolean(),
});
export const ScanValueSchema = z.object({
  input: z.string(),
  label: z.string(),
  before: JsonSchema.nullable(),
  after: JsonSchema.nullable(),
  goal: z.number().nullable(),
  format: z.enum(['number', 'currency', 'text']),
  currency: z.string().optional(),
});
export const ScanCardActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: ScanActionKindSchema,
  available: z.boolean(),
  /** Why it is locked; `approval` means a Manager PIN unlocks it. */
  lock: z.enum(['role', 'approval', 'max']).nullable(),
  reason: ScanReasonSchema.nullable(),
  amount: z
    .union([
      z.object({ fixed: z.number() }),
      z.object({
        max: z.number(),
        presets: z.array(z.number()),
        default: z.number().nullable(),
      }),
    ])
    .nullable(),
  confirm: z.boolean(),
  confirmAbove: z.number().nullable(),
  cooldownRemainingMs: z.number().int().nullable(),
  armable: z.enum(['sticky', 'once']).nullable(),
  rewardLabel: z.string().nullable(),
});
export const ScanTemplateRefSchema = z.object({ name: z.string(), style: z.string() });
export const ScanCardSchema = z.object({
  passId: IdSchema,
  version: z.number().int(),
  mode: ModeSchema,
  title: z.string(),
  subtitle: z.string().nullable(),
  template: z.object({ id: IdSchema, name: z.string(), style: z.string() }),
  status: z.enum(['active', 'voided', 'expired', 'removed']),
  validFrom: TimestampSchema.nullable(),
  validUntil: TimestampSchema.nullable(),
  flags: z
    .array(z.object({ label: z.string(), tone: z.enum(['warning', 'neutral']), stop: z.boolean() }))
    .max(4),
  /** System data from action inputs: pickers, headline subs, the desk draft preview. Not a display. */
  values: z.array(ScanValueSchema).max(3),
  actions: z.array(ScanCardActionSchema).max(6),
  /** Screen `ready`, for the desk panel. A result card never paints this one (DM 1.11 rule 13). */
  display: ScanDisplaySchema,
  lastScans: z
    .array(
      z.object({
        scanId: IdSchema,
        at: TimestampSchema,
        actionLabel: z.string(),
        outcome: ScanOutcomeKindSchema,
        scannerName: z.string(),
        undoable: z.boolean(),
      }),
    )
    .max(3),
  bundle: z
    .object({
      id: IdSchema,
      name: z.string(),
      size: z.number().int(),
      checkedIn: z.number().int().nullable(),
    })
    .nullable(),
  door: z.object({ state: z.enum(['in', 'out']).nullable() }).nullable(),
  access: ScanAccessSchema.nullable().default(null),
  /** The pass JSON minus barcode, barcodes, nfc, authenticationToken, webServiceURL and serialNumber. */
  passView: z.object({
    passJson: JsonSchema,
    assetBaseUrl: z.string(),
    assetGrant: z.string(),
    assetNames: z.array(z.string()),
  }),
});
export const ScanCountsSchema = z.object({
  today: z.number().int(),
  event: z
    .object({
      arrived: z.number().int(),
      inside: z.number().int().nullable(),
      expected: z.number().int(),
      capacity: z.number().int().nullable(),
    })
    .nullable(),
  asOf: TimestampSchema,
  configRev: z.number().int(),
});
export const ScanMilestoneSchema = z.enum(['count', 'all_in', 'reward']);
export const ScanOutcomeSchema = z.object({
  scanId: IdSchema.nullable(),
  kind: ScanOutcomeKindSchema,
  reason: ScanReasonSchema.nullable(),
  replay: z.boolean(),
  action: z.object({ id: z.string(), label: z.string(), kind: ScanActionKindSchema }).nullable(),
  card: ScanCardSchema.nullable(),
  previous: ScanPreviousSchema.nullable(),
  /** Set whenever a pass was found; on test_pass and live_pass it is the only identity. */
  template: ScanTemplateRefSchema.nullable(),
  at: TimestampSchema.nullable(),
  cooldownRemainingMs: z.number().int().nullable(),
  value: ScanValueSchema.nullable(),
  flags: z.array(z.string()),
  /** A Manager PIN can unlock this heads-up. */
  overridable: z.boolean(),
  /** The org has active managers. */
  approvals: z.boolean(),
  group: z
    .object({
      total: z.number().int(),
      done: z.number().int(),
      already: z.number().int(),
      refused: z.number().int(),
    })
    .nullable(),
  counts: ScanCountsSchema,
  milestone: ScanMilestoneSchema.nullable(),
  undoUntil: TimestampSchema.nullable(),
  access: ScanAccessSchema.nullable().default(null),
  /** The outcome's screen. Null for system screens and unknown passes, so refusals stay byte-equal across orgs. */
  display: ScanDisplaySchema.nullable(),
});
export type ScanOutcome = z.infer<typeof ScanOutcomeSchema>;
export type ScanCard = z.infer<typeof ScanCardSchema>;
export type ScanCounts = z.infer<typeof ScanCountsSchema>;

/** Shared with broadcasts and the passes list. */
export const ScanTargetSchema = z.union([
  z.object({ eventId: IdSchema, checkedIn: z.boolean() }),
  z.object({ noScanDays: z.union([z.literal(30), z.literal(90)]) }),
]);
export type ScanTarget = z.infer<typeof ScanTargetSchema>;
