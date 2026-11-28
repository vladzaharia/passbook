import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.ts';
import { ScanActRequestSchema, ScanPinSchema, ScanRoleSchema } from './scan.ts';

/** Stable codes for help requests, remote approval and reach. SD1 onwards throws them. */
export const SCAN_HELP_ERROR_CODES = [
  'HELP_NOT_NEEDED',
  'HELP_FORBIDDEN',
  'HELP_LIMIT',
  'HELP_TAKEN',
  'HELP_EXPIRED',
  'HELP_SELF',
  'HELP_RESPONDER_DEVICE',
  'HELP_NOT_YOURS',
  'HELP_ROLE',
  'HELP_APPROVER_LIMIT',
  'HELP_STALE',
  'APPROVAL_PIN_REQUIRED',
  'APPROVAL_GRANT_INVALID',
  'APPROVE_AS_NOT_ALLOWED',
  'STAFF_REAUTH',
  'STAFF_NOT_BOUND',
  'REACH_CONFIRM_REQUIRED',
  'REACH_FORBIDDEN',
  'KIOSK_NOT_ALLOWED',
  'SIGN_IN_ROLE_NOT_ALLOWED',
  'SIGN_IN_NOT_THIS_DEVICE',
] as const;
export const ScanHelpErrorCodeSchema = z.enum(SCAN_HELP_ERROR_CODES);
export type ScanHelpErrorCode = z.infer<typeof ScanHelpErrorCodeSchema>;

/** The HTTP status each code answers with. */
export const SCAN_HELP_ERROR_STATUS: Record<ScanHelpErrorCode, 401 | 403 | 409 | 410 | 429> = {
  HELP_NOT_NEEDED: 409,
  HELP_FORBIDDEN: 403,
  HELP_LIMIT: 429,
  HELP_TAKEN: 409,
  HELP_EXPIRED: 410,
  HELP_SELF: 403,
  HELP_RESPONDER_DEVICE: 403,
  HELP_NOT_YOURS: 403,
  HELP_ROLE: 403,
  HELP_APPROVER_LIMIT: 429,
  HELP_STALE: 409,
  APPROVAL_PIN_REQUIRED: 401,
  APPROVAL_GRANT_INVALID: 409,
  APPROVE_AS_NOT_ALLOWED: 403,
  STAFF_REAUTH: 401,
  STAFF_NOT_BOUND: 403,
  REACH_CONFIRM_REQUIRED: 401,
  REACH_FORBIDDEN: 403,
  KIOSK_NOT_ALLOWED: 403,
  SIGN_IN_ROLE_NOT_ALLOWED: 403,
  SIGN_IN_NOT_THIS_DEVICE: 403,
};

export const ScanHelpKindSchema = z.enum(['approval', 'help']);
export const ScanHelpTopicSchema = z.enum([
  'act',
  'let_in_again',
  'cooldown',
  'capacity',
  'access',
  'tag_confirm',
  'undo',
  'kiosk_admit',
  'kiosk_help',
  'scanner_help',
  /** "Not me" after an Approve as: a review item for the session's Managers. */
  'approve_as_review',
]);
export const ScanHelpNeedsSchema = z.enum(['manager', 'desk']);
export const ScanHelpStateSchema = z.enum([
  'open',
  'claimed',
  'approved',
  'used',
  'denied',
  'handled',
  'cancelled',
  'expired',
]);
export const SCAN_HELP_TERMINAL_STATES = [
  'used',
  'denied',
  'handled',
  'cancelled',
  'expired',
] as const satisfies readonly ScanHelpState[];
export const ScanHelpLevelSchema = z.enum(['normal', 'escalated']);
export const ScanHelpResolvedBySchema = z.enum(['responder', 'pin', 'auto', 'admin']);
export const ScanHelpRequesterClassSchema = z.enum(['scan', 'kiosk']);
/** `denyWhy` presets. */
export const ScanHelpDenyReasonSchema = z.enum([
  'not_eligible',
  'see_desk',
  'already_used',
  'other',
]);
/** Org setting `scan.approvalPin` (D29). */
export const ScanApprovalPinModeSchema = z.enum(['always', 'shared', 'never']);
export type ScanHelpKind = z.infer<typeof ScanHelpKindSchema>;
export type ScanHelpTopic = z.infer<typeof ScanHelpTopicSchema>;
export type ScanHelpState = z.infer<typeof ScanHelpStateSchema>;
export type ScanApprovalPinMode = z.infer<typeof ScanApprovalPinModeSchema>;

export const SCAN_HELP_LIFETIME_MS = {
  approval: 2 * 60_000,
  help: 5 * 60_000,
  onMyWay: 10 * 60_000,
  grant: 60_000,
} as const;
/** Re-rings of an unclaimed request, from raise. The first sets `level: 'escalated'`. */
export const SCAN_HELP_RERING_MS = [45_000, 90_000] as const;
/** `POST /scan/staff/extend` opens this long before the binding ends. */
export const STAFF_EXTEND_WINDOW_MS = 10 * 60_000;

/**
 * The reach actions that need a fresh PIN: under `scan.approvalPin: 'shared'`, on a Shared
 * device, a PIN older than `SHARED_REACH_CONFIRM_MS` gives 401 `REACH_CONFIRM_REQUIRED`.
 */
export const SCAN_REACH_FRESH_ACTIONS = [
  'approve',
  'deny',
  'remote_undo',
  'remote_sign_out',
  'kiosk_pause',
  'kiosk_resume',
] as const;
export type ScanReachFreshAction = (typeof SCAN_REACH_FRESH_ACTIONS)[number];
export const SHARED_REACH_CONFIRM_MS = 2 * 60_000;

const IdempotencyKeySchema = IdSchema;

/** `POST /scan/help`. The server re-derives every fact from `act`, `undo` or `scanId`. */
export const ScanHelpRaiseSchema = z
  .strictObject({
    kind: ScanHelpKindSchema,
    topic: ScanHelpTopicSchema,
    act: ScanActRequestSchema.optional(),
    undo: z.strictObject({ scanId: IdSchema }).optional(),
    scanId: IdSchema.optional(),
    idempotencyKey: IdempotencyKeySchema,
  })
  .refine((b) => !(b.act && b.undo), { message: 'Send act or undo, not both.', path: ['undo'] })
  .refine((b) => b.kind === 'help' || b.act || b.undo || b.scanId, {
    message: 'An approval names the act, the undo or the scan.',
    path: ['kind'],
  });
export type ScanHelpRaise = z.infer<typeof ScanHelpRaiseSchema>;

/** One help request as devices and the admin API see it. Ids only: no names or personalization. */
export const ScanHelpRequestSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  zoneId: IdSchema.nullable(),
  requesterScannerId: IdSchema,
  requesterStaffId: IdSchema.nullable(),
  requesterRole: ScanRoleSchema.nullable(),
  requesterClass: ScanHelpRequesterClassSchema,
  kind: ScanHelpKindSchema,
  topic: ScanHelpTopicSchema,
  needs: ScanHelpNeedsSchema,
  requestHash: z.string().nullable(),
  passId: IdSchema.nullable(),
  scanId: IdSchema.nullable(),
  reasonCode: z.string().nullable(),
  actionId: IdSchema.nullable(),
  amount: z.number().nullable(),
  max: z.number().nullable(),
  state: ScanHelpStateSchema,
  level: ScanHelpLevelSchema,
  raisedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  claimedByStaffId: IdSchema.nullable(),
  claimedByScannerId: IdSchema.nullable(),
  claimedAt: TimestampSchema.nullable(),
  decidedByStaffId: IdSchema.nullable(),
  decidedByScannerId: IdSchema.nullable(),
  decidedAt: TimestampSchema.nullable(),
  denyReason: ScanHelpDenyReasonSchema.nullable(),
  resolvedBy: ScanHelpResolvedBySchema.nullable(),
  grantExpiresAt: TimestampSchema.nullable(),
  usedScanId: IdSchema.nullable(),
  version: z.number().int().nonnegative(),
});
export type ScanHelpRequest = z.infer<typeof ScanHelpRequestSchema>;

export const ScanHelpRaiseResponseSchema = z.object({
  request: ScanHelpRequestSchema,
  /** Devices that were rung. */
  responders: z.number().int().nonnegative(),
});

/** `GET /scan/help`. */
export const ScanHelpListQuerySchema = z.strictObject({
  open: z.enum(['0', '1']).optional(),
  mine: z.enum(['0', '1']).optional(),
});
export const ScanHelpListSchema = z.object({ items: z.array(ScanHelpRequestSchema).max(100) });

/** `GET /scan/help/{id}`: the request plus what the responder shows. */
export const ScanHelpDetailSchema = z.object({
  request: ScanHelpRequestSchema,
  card: z.object({
    /** Masked: first name and last initial. */
    holder: z.string().nullable(),
    passLabel: z.string().nullable(),
    photoUrl: z.string().nullable(),
  }),
});

export const ScanHelpClaimSchema = z.strictObject({ version: z.number().int().nonnegative() });
export const ScanHelpReleaseSchema = z.strictObject({});
export const ScanHelpCancelSchema = z.strictObject({});
/** `pin` is required under `scan.approvalPin: 'always'`. */
export const ScanHelpResolveSchema = z
  .strictObject({
    outcome: z.enum(['approved', 'denied', 'handled']),
    denyReason: ScanHelpDenyReasonSchema.optional(),
    pin: ScanPinSchema.optional(),
    version: z.number().int().nonnegative(),
    idempotencyKey: IdempotencyKeySchema,
  })
  .refine((b) => b.outcome === 'denied' || b.denyReason === undefined, {
    message: 'Only a deny takes a reason.',
    path: ['denyReason'],
  });
export type ScanHelpResolve = z.infer<typeof ScanHelpResolveSchema>;

/** `GET /scan/approvers?requestHash=` (`never` mode only). */
export const ScanApproversQuerySchema = z.strictObject({
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const ScanApproverSchema = z.object({
  staffId: IdSchema,
  /** The last initial is added when two first names on the list match. */
  firstName: z.string(),
  role: ScanRoleSchema,
});
export const ScanApproversSchema = z.object({ items: z.array(ScanApproverSchema).max(100) });

/** `POST /scan/staff/extend`: the bound person's own PIN. */
export const ScanStaffExtendSchema = z.strictObject({ pin: ScanPinSchema });

/** `PUT /scan/push`: a Web Push subscription for the signed-in staff member. */
export const ScanPushSubscriptionSchema = z.strictObject({
  endpoint: z.url().max(2048),
  keys: z.strictObject({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(64) }),
});

/** Pause, resume and sign-out of another device. `pin` is required under `always`. */
export const ScanReachPinSchema = z.strictObject({ pin: ScanPinSchema.optional() });

/** `GET /scan-help` (admin). `scannerId` matches the requester or the decider. */
export const ScanHelpAdminQuerySchema = z.strictObject({
  sessionId: IdSchema.optional(),
  scannerId: IdSchema.optional(),
  state: ScanHelpStateSchema.optional(),
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  cursor: z.string().max(200).optional(),
});
export const ScanHelpAdminListSchema = z.object({
  items: z.array(ScanHelpRequestSchema).max(100),
  nextCursor: z.string().nullable(),
});
/** `POST /scan-help/{id}/resolve` (admin): never approve or deny. */
export const ScanHelpAdminResolveSchema = z.strictObject({
  outcome: z.enum(['handled', 'cancelled']),
});
