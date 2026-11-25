import { z } from 'zod';
import { ChannelSchema } from './channels.ts';
import { CheckInPolicySchema, CheckInStateSchema, SetupDirectionSchema } from './check-in.ts';
import { IdSchema, JsonSchema, ModeSchema, TimestampSchema } from './common.ts';
import { ScannerTagsSettingsSchema, ScanTagSchema, TagReadSchema } from './nfc-tags.ts';
import { ScanAccessSchema } from './scan-access.ts';
import { ScanActionInputSchema } from './scan-action-input.ts';
import { ScanAdmitSchema, ScanTypeCountSchema } from './scan-admit.ts';
import {
  ScanActionApprovalSchema,
  ScanAdminScopeSchema,
  ScanApprovalSchema,
  ScanDirectionSchema,
  UuidV7Schema,
} from './scan-base.ts';
import { ScanDisplayReadSchema } from './scan-display.ts';
import { ScanOccupancySchema, ScanPlaceCountSchema } from './scan-occupancy.ts';
import { ScanValueSchema } from './scan-value.ts';

// Moved to leaf files so the access and occupancy contracts can use them without a cycle.
export { type ScanAccess, ScanAccessSchema } from './scan-access.ts';
export type { ScanActionInput } from './scan-action-input.ts';
export { ScanActionInputSchema } from './scan-action-input.ts';
export {
  ScanAdminScopeSchema,
  ScanApprovalSchema,
  ScanDirectionSchema,
  TimeZoneSchema,
  UuidV7Schema,
} from './scan-base.ts';

import { ScanBundleSchema, ScanGroupMemberSchema } from './scan-group.ts';

export { type ScanOccupancy, ScanOccupancySchema } from './scan-occupancy.ts';
export { ScanValueSchema } from './scan-value.ts';

export const ScanMethodSchema = z.enum(['camera', 'wedge', 'nfc', 'manual']);
export type ScanMethod = z.infer<typeof ScanMethodSchema>;
/** What a record shows: the system's auto tap-out has a method of its own; no client sends it. */
export const ScanRecordMethodSchema = z.enum([...ScanMethodSchema.options, 'auto']);
export const ScanActionKindSchema = z.enum(['check_in', 'add', 'take', 'set', 'use_up']);
export const ScanRoleSchema = z.enum(['door', 'desk', 'manager']);
export type ScanRole = z.infer<typeof ScanRoleSchema>;
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
  'code_replaced',
  'ambiguous',
  'test_pass',
  'live_pass',
  'not_accepted',
  'wrong_event',
  'removed',
  'voided',
  'expired',
  'no_balance',
  'card_full',
  'managed_elsewhere',
  'limit_reached',
  'zone_not_included',
  'outside_hours',
  'guest_expired',
  'guest_visits_used',
  'suspended',
  'tag_lost',
  'tag_not_allowed',
  'tag_invalid',
  'tag_expired',
  'channel_off',
  'print_replaced',
  'print_voided',
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
  'still_inside',
  'not_inside',
] as const;
export const ScanReasonSchema = z.enum([
  ...SCAN_REFUSED_REASONS,
  ...SCAN_HEADS_UP_REASONS,
  'choose',
]);
export type ScanReason = z.infer<typeof ScanReasonSchema>;
export const ScannerSettingsSchema = z.object({
  checkIn: CheckInPolicySchema.optional(),
  direction: SetupDirectionSchema.optional(),
  showPhoto: z.boolean().optional(),
  acceptAllTemplates: z.boolean().optional(),
  flow: z.enum(['auto', 'choose']),
  defaultActionId: z.string().min(1).max(32).nullable(),
  roleWithoutSignIn: z.enum(['door', 'desk']),
  staffSignIn: z.boolean(),
  letInAgain: z.enum(['anyone', 'manager', 'never']),
  reader: z.enum(['none', 'barcode', 'nfc']),
  lookup: z.boolean(),
  offline: z.boolean(),
  whenOffline: z.enum(['stop', 'decide', 'list']).optional(),
  dailyAmount: z.number().int().min(1).max(10_000_000).nullable(),
  /** A monitor may act (Let in, Mark as out) when this is on. Off when absent. */
  deskActions: z.boolean().optional(),
  /** A full place refuses every role: `capacity_full` is never overridable at this door. */
  hardLimit: z.boolean().optional(),
  /** Whose PIN approves a risky action. Managers when absent; `set` and hard refusals never relax. */
  approvals: z.enum(['managers', 'desk']).optional(),
  /** Who may assign tags here. Absent: desk for a pass, manager for a person. */
  tags: ScannerTagsSettingsSchema.optional(),
});
export type ScannerSettings = z.infer<typeof ScannerSettingsSchema>;

export const ScanInputSchema = z.union([
  z.object({ code: z.string().min(1).max(1024), method: ScanMethodSchema }),
  z.object({ passId: IdSchema, method: z.literal('manual') }),
  /** `passId` pins the pass a resolve showed; act only. */
  z.object({ tag: TagReadSchema, method: z.literal('nfc'), passId: IdSchema.optional() }),
]);
export type ScanInput = z.infer<typeof ScanInputSchema>;
/**
 * What the code and pass-id paths take. A tag read reaches them as the pass it chose, read by NFC
 * (worker only: the wire never sends `passId` with `nfc`).
 */
export type ScanCodeInput =
  | Exclude<ScanInput, { tag: unknown }>
  | { passId: string; method: 'nfc' };

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
  approval: ScanActionApprovalSchema.optional(),
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
  /** A `set` with no fixed value: what it accepts. */
  input: ScanActionInputSchema.optional(),
});
export const ScanTemplateRefSchema = z.object({ name: z.string(), style: z.string() });
export const ScanCardSchema = z.object({
  checkIn: CheckInStateSchema.optional(),
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
  display: ScanDisplayReadSchema,
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
  bundle: ScanBundleSchema.nullable(),
  door: z.object({ state: z.enum(['in', 'out']).nullable() }).nullable(),
  access: ScanAccessSchema.nullable().default(null),
  /** The tag this was read from. Desk and up only; never on a customer screen. */
  tag: ScanTagSchema.nullable().optional(),
  /** Where the pass is now, for a scanner with a place. Null on every other card. */
  occupancy: ScanOccupancySchema.nullable().optional(),
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
  /** The scanner's zone, when it has one. Null on every other scanner. */
  place: ScanPlaceCountSchema.nullable().optional(),
  byType: z.array(ScanTypeCountSchema).optional(),
  asOf: TimestampSchema,
  configRev: z.number().int(),
});
export const ScanMilestoneSchema = z.enum(['count', 'all_in', 'reward']);
export const ScanOutcomeSchema = z.object({
  checkIn: CheckInStateSchema.optional(),
  scanId: IdSchema.nullable(),
  kind: ScanOutcomeKindSchema,
  reason: ScanReasonSchema.nullable(),
  replay: z.boolean(),
  action: z.object({ id: z.string(), label: z.string(), kind: ScanActionKindSchema }).nullable(),
  card: ScanCardSchema.nullable(),
  previous: ScanPreviousSchema.nullable(),
  /** The scanner's event, on `wrong_event`, `not_yet_valid`, `ended` and `capacity_full`. */
  event: z.object({ name: z.string(), startsAt: TimestampSchema }).nullable().optional(),
  /** Set whenever a pass was found; on test_pass and live_pass it is the only identity. */
  template: ScanTemplateRefSchema.nullable(),
  at: TimestampSchema.nullable(),
  cooldownRemainingMs: z.number().int().nullable(),
  value: ScanValueSchema.nullable(),
  flags: z.array(z.string()),
  /** The channel a `channel_off` refusal names. */
  channel: ChannelSchema.nullable().optional(),
  overridable: z.boolean(), // A Manager PIN can unlock this heads-up.
  exitAllowed: z.boolean().optional(), // OC4: a voided or ended pass that is inside can only check out
  /** The org has active managers. */
  approvals: z.boolean(),
  group: z
    .object({
      total: z.number().int(),
      done: z.number().int(),
      already: z.number().int(),
      refused: z.number().int(),
      members: z.array(ScanGroupMemberSchema).max(10).optional(),
    })
    .nullable(),
  /** The bundle behind the scanned pass: the "Check in all" chip. Also on `card` for a ready card. */
  bundle: ScanBundleSchema.nullable().optional(),
  inBundle: z.boolean().optional(), // act answers: the pass is in a bundle (the members come from resolve)
  counts: ScanCountsSchema,
  milestone: ScanMilestoneSchema.nullable(),
  undoUntil: TimestampSchema.nullable(),
  access: ScanAccessSchema.nullable().default(null),
  admit: ScanAdmitSchema.nullable().optional(),
  tag: ScanTagSchema.nullable().optional(),
  occupancy: ScanOccupancySchema.nullable().optional(),
  /** The outcome's screen. Null for system screens and unknown passes, so refusals stay byte-equal across orgs. */
  display: ScanDisplayReadSchema.nullable(),
});
export type ScanOutcome = z.infer<typeof ScanOutcomeSchema>;
export type ScanCard = z.infer<typeof ScanCardSchema>;
export type ScanCounts = z.infer<typeof ScanCountsSchema>;
/** Shared with broadcasts and the passes list. */
export const ScanTargetSchema = z.union([
  z.object({ eventId: IdSchema, checkedIn: z.boolean() }),
  z.object({ noScanDays: z.number().int().min(1).max(730) }),
]);
export type ScanTarget = z.infer<typeof ScanTargetSchema>;
