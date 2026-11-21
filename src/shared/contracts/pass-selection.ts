import { z } from 'zod';
import { PassMatchSchema } from './broadcasts.ts';
import { IdSchema } from './common.ts';
import { BULK_PASS_LIMIT, PassListStatusSchema } from './passes.ts';
import { ScanTargetSchema } from './scan.ts';

// Which passes a bulk run acts on: explicit ids, or the passes list's filter with the count the admin
// saw. Kept beside passes.ts, which is at its size limit. Additive: `POST /passes/bulk` takes `ids`
// until find by any field lands.

/** The passes list's filters as JSON. `match` without `templateId` needs one type across the org. */
export const PassFilterSchema = z.strictObject({
  templateId: IdSchema.optional(),
  connectionId: IdSchema.optional(),
  importId: IdSchema.optional(),
  status: PassListStatusSchema.optional(),
  holderEmail: z.string().max(254).optional(),
  holderState: z.enum(['unassigned', 'waiting', 'owned']).optional(),
  onDevice: z.boolean().optional(),
  q: z.string().max(200).optional(),
  externalId: z.string().min(1).max(200).optional(),
  scan: ScanTargetSchema.optional(),
  match: PassMatchSchema.optional(),
});
export type PassFilter = z.infer<typeof PassFilterSchema>;

/** A filter run is refused when the server's count drifts more than this from `expectCount`. */
export const SELECTION_DRIFT = 0.02;

/** A `contains` match or a filter run refuses more than this many passes (`MATCH_TOO_BROAD`). */
export const PASS_SELECTION_MAX = 50_000;

export const PassSelectionSchema = z.union([
  z.strictObject({ ids: z.array(IdSchema).min(1).max(BULK_PASS_LIMIT) }),
  z.strictObject({
    filter: PassFilterSchema,
    /** The count the admin saw; a drift over 2% answers 409 `SELECTION_CHANGED`. */
    expectCount: z.number().int().min(1).max(PASS_SELECTION_MAX),
  }),
]);
export type PassSelection = z.infer<typeof PassSelectionSchema>;

/** True when the server's count moved too far from the one the admin confirmed. */
export const selectionDrifted = (expectCount: number, count: number): boolean =>
  Math.abs(count - expectCount) > Math.max(0, expectCount * SELECTION_DRIFT);
