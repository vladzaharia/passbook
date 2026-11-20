import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.ts';
import { PlaceKeySchema } from './scan-occupancy.ts';

/** `none` takes a mark back. */
export const RollCallStatusSchema = z.enum(['present', 'out', 'none']);
export type RollCallStatus = z.infer<typeof RollCallStatusSchema>;

export const ROLL_CALL_MAX_PEOPLE = 2000;
export const ROLL_CALL_MAX_MARKS = 100;

/** `PUT /scan/roll-call/{id}/marks`: one tap, or the queue an offline device sends. `at` is the device's time. */
export const RollCallMarksRequestSchema = z.strictObject({
  marks: z
    .array(
      z.strictObject({
        passId: IdSchema,
        status: RollCallStatusSchema,
        at: TimestampSchema.optional(),
      }),
    )
    .min(1)
    .max(ROLL_CALL_MAX_MARKS),
});

export const RollCallPersonSchema = z.object({
  passId: IdSchema,
  holder: z.string().nullable(),
  plan: z.string().nullable(),
  host: z.string().nullable(),
  place: PlaceKeySchema,
  placeName: z.string(),
  since: TimestampSchema,
  /** `in_now` where tap-out is required, `tapped_in` where it is not. */
  basis: z.enum(['in_now', 'tapped_in']),
  /** Now: inside, left, or past Max stay or Clear at with no one confirming the exit. */
  presence: z.enum(['in', 'left', 'lapsed']),
  /** Tapped in after the call started. */
  late: z.boolean(),
  mark: z.object({ status: RollCallStatusSchema, by: z.string(), at: TimestampSchema }).nullable(),
  /** The system closed the stay and no one has confirmed it. */
  notConfirmedOut: z.boolean(),
});
export type RollCallPerson = z.infer<typeof RollCallPersonSchema>;

export const RollCallSchema = z.object({
  id: IdSchema,
  placeNames: z.array(z.string()),
  startedAt: TimestampSchema,
  startedBy: z.string(),
  endedAt: TimestampSchema.nullable(),
  endedBy: z.string().nullable(),
  /** Raised by every mark: a lower one never replaces a higher. */
  rev: z.number().int().min(0),
  counts: z.object({
    total: z.number().int().min(0),
    present: z.number().int().min(0),
    out: z.number().int().min(0),
    unconfirmed: z.number().int().min(0),
    notConfirmedOut: z.number().int().min(0),
    late: z.number().int().min(0),
    inNow: z.number().int().min(0),
    tappedIn: z.number().int().min(0),
  }),
  people: z.array(RollCallPersonSchema).max(ROLL_CALL_MAX_PEOPLE + 500),
});
export type RollCall = z.infer<typeof RollCallSchema>;

/** `GET /scan/roll-call`: the session's open call, or null. */
export const RollCallCurrentSchema = z.object({ rollCall: RollCallSchema.nullable() });
export type RollCallCurrent = z.infer<typeof RollCallCurrentSchema>;
