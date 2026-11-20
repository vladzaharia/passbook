import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.ts';
import { PlaceKeySchema, ScanPlaceRevSchema } from './scan-occupancy.ts';

/** `GET /scan/live/inside`: Who's in, for a Desk-role scanner or a monitor with Desk actions. */
export const ScanWhosInQuerySchema = z.object({
  /** One place of the session's scope; omitted: every tracked place it checks. */
  place: PlaceKeySchema.optional(),
  /** Name filter: case-insensitive, contained in the holder's name. */
  q: z.string().trim().max(80).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const ScanWhosInRowSchema = z.object({
  passId: IdSchema,
  /** The holder's name as this role may see it; null when hidden. */
  holder: z.string().nullable(),
  photoUrl: z.string().nullable(),
  /** The access plan's label (an Access card), else null. */
  plan: z.string().nullable(),
  /** The pass type: the plan label, else the template name. */
  type: z.string().nullable(),
  /** A visitor's host, from the pass's host input when the template has one. */
  host: z.string().nullable(),
  place: PlaceKeySchema,
  placeName: z.string(),
  /** The zone above it, when that zone is tracked and in scope. */
  parentName: z.string().nullable(),
  since: TimestampSchema,
  /** Max stay or Clear at: when the row falls due. */
  dueAt: TimestampSchema.nullable(),
  /** The scanner of the last transition. */
  via: z.string().nullable(),
  flags: z.array(z.enum(['long_stay', 'pass_ended'])).max(2),
});
export type ScanWhosInRow = z.infer<typeof ScanWhosInRowSchema>;

export const ScanWhosInListSchema = z.object({
  items: z.array(ScanWhosInRowSchema).max(100),
  /** Everyone inside the requested places now, whatever `q` says. */
  count: z.number().int().min(0),
  /** The highest revision of those places: a lower one never replaces a higher. */
  rev: z.number().int().min(0),
  /** One count per place in scope, tree order. */
  places: z.array(ScanPlaceRevSchema).max(64),
  nextCursor: z.string().nullable(),
});
export type ScanWhosInList = z.infer<typeof ScanWhosInListSchema>;

/** The console's Mark as out: the row's pass and place. The caller is the actor. */
export const ScanConsoleMarkOutSchema = z.strictObject({ passId: IdSchema, place: PlaceKeySchema });
