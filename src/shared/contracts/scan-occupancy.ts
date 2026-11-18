import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.ts';
import {
  ScanAdminScopeSchema,
  ScanApprovalSchema,
  ScanDirectionSchema,
  UuidV7Schema,
} from './scan-base.ts';

/** `zone:<id>` or `event:<id>`: the key of `scan_presence` scope and `scan_place_revs`. */
export const PlaceKeySchema = z.string().regex(/^(zone|event):\S{1,64}$/);
export const OccupancyModeSchema = z.enum(['off', 'track', 'enforce']);

export const OccupancyFieldsSchema = z.object({
  occupancy: OccupancyModeSchema,
  capacity: z.number().int().min(1).max(100_000).nullable(),
  maxStayMinutes: z.number().int().min(15).max(2880).nullable(),
  clearAt: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM.')
    .nullable(),
});
type Limits = { capacity?: number | null; maxStayMinutes?: number | null; clearAt?: string | null };
/** Capacity, max stay and clear-at need Track. The database CHECK says the same. */
export const hasNoLimits = (s: Limits): boolean =>
  s.capacity == null && s.maxStayMinutes == null && s.clearAt == null;
export const NEEDS_TRACKING = { message: 'Turn on tracking first.', path: ['occupancy'] };
export const OccupancySettingsSchema = OccupancyFieldsSchema.refine(
  (s) => s.occupancy !== 'off' || hasNoLimits(s),
  NEEDS_TRACKING,
);

export const ScanOutCauseSchema = z.enum(['stay', 'clear', 'desk', 'forced', 'zone']);
export const OVERRIDE_NOTES = ['forgot_out', 'known', 'paid', 'other'] as const;
export const ScanOverrideNoteSchema = z.enum(OVERRIDE_NOTES);

/** Where a pass is, after a scan or now (on a card). */
export const ScanOccupancySchema = z.object({
  place: z.object({ kind: z.enum(['zone', 'event']), id: IdSchema, name: z.string() }),
  /** What this scan did or asked. */
  direction: ScanDirectionSchema,
  /** Inferred on a Both scanner. */
  auto: z.boolean(),
  state: z.enum(['in', 'out']),
  /** In: since. Out: when they left. */
  since: TimestampSchema.nullable(),
  /** The scanner of the last transition. */
  via: z.string().nullable(),
  /** On an exit. */
  stayMs: z.number().int().nullable(),
  /** The place's count, when the scanner may see it. */
  inNow: z.number().int().nullable(),
  capacity: z.number().int().nullable(),
  /** A held Auto flip: the dock's one-tap direction. */
  turnaround: z.enum(['in', 'out']).nullable(),
  /** On `not_inside`: the zone the person must be in first. */
  parent: z.object({ id: IdSchema, name: z.string() }).nullable().optional(),
});
export type ScanOccupancy = z.infer<typeof ScanOccupancySchema>;
export const ScanPlaceCountSchema = z.object({
  name: z.string(),
  inNow: z.number().int(),
  capacity: z.number().int().nullable(),
});
/** A monitor's count for one place. `rev` orders them: a lower one never replaces a higher. */
export const ScanPlaceRevSchema = ScanPlaceCountSchema.extend({
  place: PlaceKeySchema,
  rev: z.number().int().min(0),
});
export type ScanPlaceRev = z.infer<typeof ScanPlaceRevSchema>;

export const ScanOverrideRequestSchema = z.strictObject({
  idempotencyKey: UuidV7Schema,
  /** The heads-up or refused scan being overridden. */
  overrideOf: IdSchema,
  approval: ScanApprovalSchema.optional(),
  note: ScanOverrideNoteSchema.optional(),
  scope: ScanAdminScopeSchema.optional(),
});
export const ScanOverrideNoteRequestSchema = z.strictObject({ note: ScanOverrideNoteSchema });
export const ScanMarkOutRequestSchema = z.strictObject({
  idempotencyKey: UuidV7Schema,
  passId: IdSchema,
  place: PlaceKeySchema,
  approval: ScanApprovalSchema.optional(),
  scope: ScanAdminScopeSchema.optional(),
});

export const ScanInsideRowSchema = z.object({
  passId: IdSchema,
  holder: z.string().nullable(),
  photoUrl: z.string().nullable(),
  plan: z.string().nullable(),
  place: PlaceKeySchema,
  since: TimestampSchema,
  via: z.string().nullable(),
  flags: z.array(z.enum(['long_stay', 'pass_ended'])).max(2),
});
export type ScanInsideRow = z.infer<typeof ScanInsideRowSchema>;
export const ScanInsideListSchema = z.object({
  items: z.array(ScanInsideRowSchema).max(100),
  total: z.number().int().min(0),
  nextCursor: z.string().nullable(),
});
export const ScanInsideQuerySchema = z.object({
  place: PlaceKeySchema,
  cursor: z.string().max(512).optional(),
});
