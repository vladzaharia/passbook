import { z } from 'zod';
import { PassMatchSchema } from './broadcasts.ts';
import { IdSchema } from './common.ts';
import { BULK_PASS_LIMIT, BulkPassActionSchema, PassListStatusSchema } from './passes.ts';
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

/** Most passes a filter selection acts on inline in `POST /passes/bulk`; above it a bulk run takes over. */
export const FILTER_RUN_MAX = 100;

/** A filter selection or bulk run refuses more than this many passes (`MATCH_TOO_BROAD`). */
export const PASS_SELECTION_MAX = 20_000;

export const PassSelectionSchema = z.union([
  z.strictObject({ ids: z.array(IdSchema).min(1).max(BULK_PASS_LIMIT) }),
  z.strictObject({
    filter: PassFilterSchema,
    /** The count the admin saw; any difference answers 409 `SELECTION_CHANGED`. */
    expectCount: z.number().int().min(1).max(PASS_SELECTION_MAX),
  }),
]);
export type PassSelection = z.infer<typeof PassSelectionSchema>;

/** Any change in the count refuses the run: the admin confirms the new number first. */
export const selectionDrifted = (expectCount: number, count: number): boolean =>
  expectCount !== count;

/**
 * The body of `POST /passes/bulk`: `ids` (as before) or a `selection`, never both. A filter selection
 * needs `orgId` unless the key is bound to one.
 */
export const BulkPassRequestSchema = BulkPassActionSchema.omit({ ids: true })
  .extend({
    ids: BulkPassActionSchema.shape.ids.optional(),
    selection: PassSelectionSchema.optional(),
  })
  .refine((b) => (b.ids === undefined) !== (b.selection === undefined), {
    message: 'Send ids or a selection.',
    path: ['selection'],
  });
export type BulkPassRequest = z.infer<typeof BulkPassRequestSchema>;
