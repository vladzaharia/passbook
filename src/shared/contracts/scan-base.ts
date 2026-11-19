import { z } from 'zod';
import { IdSchema } from './common.ts';

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
/** A Manager's PIN for one action. `staffId` is optional: a PIN alone is matched against the org's managers. */
export const ScanApprovalSchema = z.object({
  staffId: IdSchema.optional(),
  pin: z.string().regex(/^\d{6}$/),
});
