import { z } from 'zod';
import { IdSchema } from './common.ts';

/** Idempotency keys: UUIDv7, made by the client. No `i` flag: the document would print it inside the pattern. */
export const UuidV7Schema = z
  .string()
  .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/);

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

export const ScanDirectionSchema = z.enum(['in', 'out']);
/**
 * An admin names the org, and optionally the event or templates, per request: in the JSON body's
 * `scope`, or on a GET as `?orgId&eventId&templateIds=a,b&timeZone`. The asset route, which an
 * `<img>` loads, takes the same query next to `g`. A scanner never sends it.
 */
export const ScanAdminScopeSchema = z.object({
  setupId: IdSchema.optional(),
  orgId: IdSchema,
  eventId: IdSchema.optional(),
  templateIds: z.array(IdSchema).max(100).optional(),
  timeZone: TimeZoneSchema,
});
export const ScanPinSchema = z.string().regex(/^\d{6}$/);
/** A Manager's PIN for one action. `staffId` is optional: a PIN alone is matched against the org's managers. */
export const ScanApprovalSchema = z.object({
  staffId: IdSchema.optional(),
  pin: ScanPinSchema,
});
/** A remote approval the requester redeems: the help request a responder approved (SDA §10). */
export const ScanGrantApprovalSchema = z.strictObject({ requestId: IdSchema });
/** Approve as a named on-shift approver, with no PIN. Only under `scan.approvalPin: 'never'` (D29). */
export const ScanApproveAsSchema = z.strictObject({ approveAs: IdSchema });
/** An action's approval: a PIN (the requester may confirm `alone` with their own when no other staff can approve here), a grant, or Approve as. */
export const ScanActionApprovalSchema = z.union([
  ScanApprovalSchema.extend({ alone: z.boolean().optional() }).strict(),
  ScanGrantApprovalSchema,
  ScanApproveAsSchema,
]);
export type ScanActionApproval = z.infer<typeof ScanActionApprovalSchema>;
/** An undo's approval: the same three forms, without `alone`. */
export const ScanUndoApprovalSchema = z.union([
  ScanApprovalSchema.strict(),
  ScanGrantApprovalSchema,
  ScanApproveAsSchema,
]);
export type ScanUndoApproval = z.infer<typeof ScanUndoApprovalSchema>;
