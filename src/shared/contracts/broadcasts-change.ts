import { z } from 'zod';
import { BroadcastPreviewSchema, BroadcastTargetSchema, PassMatchSchema } from './broadcasts.ts';
import { IdSchema, JsonSchema, PlainLineSchema } from './common.ts';
import { FieldChangeSchema } from './issuing.ts';

const n = z.number().int().nonnegative();

// Change runs: a `change` broadcast started from Passes. Apart from broadcasts.ts so the console's
// first load stays small. Additive: create and preview validate with broadcasts.ts until the
// change-run server takes these.

export const CHANGE_RUN_MAX_PASS_IDS = 5000;
export const CHANGE_RUN_MESSAGE_MAX = 120;
export const CHANGE_RUN_UNDO_MS = 24 * 3_600_000;

/** Exactly one of templates (with the filters), explicit pass ids, or the passes of one import. */
export const ChangeRunTargetSchema = BroadcastTargetSchema.extend({
  templateIds: BroadcastTargetSchema.shape.templateIds.optional(),
  match: PassMatchSchema.optional(),
  passIds: z.array(IdSchema).min(1).max(CHANGE_RUN_MAX_PASS_IDS).optional(),
  importId: IdSchema.optional(),
  /** The count the admin saw; the server re-counts. */
  expectCount: n.optional(),
}).refine(
  (t) => [t.templateIds, t.passIds, t.importId].filter((v) => v !== undefined).length === 1,
  'Target templates, pass ids or one import.',
);
export type ChangeRunTarget = z.infer<typeof ChangeRunTargetSchema>;

/** `shift` is an ISO 8601 duration for dates (`P1Y`, `-P7D`); `add` is for numbers. */
export const PatchOpSchema = z.union([
  z.strictObject({ set: JsonSchema }),
  z.strictObject({ clear: z.literal(true) }),
  z.strictObject({
    shift: z
      .string()
      .regex(/^-?P(?=\d)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?$/, 'Use a duration like P1Y or P30D.'),
  }),
  z.strictObject({ add: z.number().finite() }),
]);
export type PatchOp = z.infer<typeof PatchOpSchema>;
export const PatchOpsSchema = z
  .record(z.string().min(1).max(64), PatchOpSchema)
  .refine((p) => Object.keys(p).length >= 1 && Object.keys(p).length <= 40, 'Set 1 to 40 inputs.');

/** Lock-screen text; `{Label}` tokens read the pass's new value of that field. */
export const ChangeRunMessageSchema = PlainLineSchema(CHANGE_RUN_MESSAGE_MAX);

export const ChangeRunFieldsSchema = z.object({
  target: ChangeRunTargetSchema,
  ops: PatchOpsSchema,
  notify: z.boolean().default(false),
  message: ChangeRunMessageSchema.optional(),
});

/** `POST /broadcasts/{id}/undo`: a silent child broadcast restores items still at the run's value. */
export const BroadcastUndoResultSchema = z.object({
  id: IdSchema,
  parentId: IdSchema,
  /** Items still at the run's value, which the undo restores. */
  restorable: n,
  /** Items changed since the run, which it keeps. */
  kept: n,
});

/** `POST /broadcasts/preview` for a change run: the counts plus sample diffs. */
export const ChangeRunPreviewSchema = BroadcastPreviewSchema.extend({
  samples: z
    .array(
      z.object({
        passId: IdSchema,
        title: z.string().nullable(),
        changes: z.array(FieldChangeSchema),
      }),
    )
    .max(20),
  /** Passes already at the new values. */
  unchanged: n,
  /** Passes the run cannot change, by reason code. */
  blocked: z.array(z.object({ code: z.string().max(64), count: n })),
  notified: n,
  silent: n,
});
