import { z } from 'zod';
import {
  BroadcastPatchSchema,
  BroadcastPreviewSchema,
  BroadcastTargetSchema,
  createBroadcastFields,
  PassMatchSchema,
  refineCreateBroadcast,
} from './broadcasts.ts';
import { IdSchema, type Json, JsonSchema, PlainLineSchema } from './common.ts';
import { FieldChangeSchema } from './issuing.ts';

const n = z.number().int().nonnegative();

// Change runs: a `change` broadcast started from Passes. Apart from broadcasts.ts so the console's
// first load stays small.

export const CHANGE_RUN_MAX_PASS_IDS = 5000;
export const CHANGE_RUN_MESSAGE_MAX = 120;
export const CHANGE_RUN_UNDO_MS = 24 * 3_600_000;

/** Exactly one of templates (with the filters), explicit pass ids, or the passes of one import. */
export const ChangeRunTargetSchema = BroadcastTargetSchema.extend({
  templateIds: BroadcastTargetSchema.shape.templateIds.optional(),
  match: PassMatchSchema.optional(),
  passIds: z.array(IdSchema).min(1).max(CHANGE_RUN_MAX_PASS_IDS).optional(),
  importId: IdSchema.optional(),
  /** The count the admin saw; the server re-counts and refuses a drift over 2% (`SELECTION_CHANGED`). */
  expectCount: n.optional(),
})
  .strict()
  .refine(
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

const OP_KEYS = ['set', 'clear', 'shift', 'add'];

/** A run that does one thing to every pass instead of setting inputs: `{ "$void": true }` or `{ "$design": true }` (latest design). */
export type ChangeAction = 'void' | 'design';

/** The action a patch names, or null for a patch of inputs. Input names never start with `$`. */
export function changeActionOf(patch: Readonly<Record<string, Json>>): ChangeAction | null {
  if (patch.$void === true) return 'void';
  return patch.$design === true ? 'design' : null;
}

/**
 * A change's patch as one op per input. A value that is an object with one key `set`, `clear`, `shift`
 * or `add` is that op; any other value is a plain `set`, so a patch from before ops still reads.
 */
export function changeOpsOf(patch: Readonly<Record<string, Json>>): {
  ops: Record<string, PatchOp>;
  issues: { key: string; message: string }[];
} {
  const ops: Record<string, PatchOp> = {};
  const issues: { key: string; message: string }[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (key.startsWith('$')) continue;
    const keys =
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.keys(value)
        : [];
    const first = keys[0];
    if (keys.length === 1 && first !== undefined && OP_KEYS.includes(first)) {
      const parsed = PatchOpSchema.safeParse(value);
      if (parsed.success) ops[key] = parsed.data;
      else issues.push({ key, message: parsed.error.issues[0]?.message ?? 'Not a valid change.' });
    } else ops[key] = { set: value };
  }
  return { ops, issues };
}

/** Lock-screen text; `{Label}` tokens read the pass's new value of that field. */
export const ChangeRunMessageSchema = PlainLineSchema(CHANGE_RUN_MESSAGE_MAX);

/** `POST /broadcasts`: a message, or a change run with the wider target and per-input ops. */
export const CreateBroadcastBodySchema = z
  .object({
    ...createBroadcastFields,
    /** A message notifies by default; a change tells holders only when asked (`true`). */
    notify: z.boolean().optional(),
    target: ChangeRunTargetSchema,
    patch: BroadcastPatchSchema,
    /** A change run's lock-screen text; it needs `notify`. */
    message: ChangeRunMessageSchema.optional(),
  })
  .superRefine((body, ctx) => {
    refineCreateBroadcast(body, ctx);
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    const { target } = body;
    if (body.kind === 'message') {
      if (!target.templateIds) issue(['target'], 'A message targets templates.');
      if (body.message !== undefined) issue(['message'], 'A message sets its text in the patch.');
      return;
    }
    const dollar = Object.keys(body.patch).filter((k) => k.startsWith('$'));
    if (dollar.length > 0) {
      if (
        dollar.length !== 1 ||
        Object.keys(body.patch).length !== 1 ||
        !changeActionOf(body.patch)
      )
        issue(
          ['patch'],
          'Void or use the latest design on their own: {"$void": true} or {"$design": true}.',
        );
      if (body.message !== undefined) issue(['message'], 'This change has no lock-screen text.');
      return;
    }
    for (const bad of changeOpsOf(body.patch).issues) issue(['patch', bad.key], bad.message);
    if (body.message !== undefined && body.notify !== true)
      issue(['message'], 'Turn on notify to send it.');
    if (target.match && (target.match.length > 3 || target.match.some((c) => 'op' in c)))
      issue(['target', 'match'], 'Runs match up to 3 values or ranges.');
  });
export type CreateBroadcastBody = z.infer<typeof CreateBroadcastBodySchema>;
/** Saves new values over a draft or a scheduled run that has not started. Same rules as create. */
export const UpdateBroadcastBodySchema = CreateBroadcastBodySchema;

/** `POST /broadcasts/preview`: the target, and for a change the ops and text to show samples. */
export const ChangePreviewBodySchema = z
  .object({
    orgId: createBroadcastFields.orgId,
    target: ChangeRunTargetSchema,
    patch: BroadcastPatchSchema.optional(),
    notify: z.boolean().optional(),
    message: ChangeRunMessageSchema.optional(),
  })
  .superRefine((body, ctx) => {
    if (body.patch)
      for (const bad of changeOpsOf(body.patch).issues)
        ctx.addIssue({ code: 'custom', path: ['patch', bad.key], message: bad.message });
    if (body.target.match?.some((c) => 'op' in c))
      ctx.addIssue({
        code: 'custom',
        path: ['target', 'match'],
        message: 'Runs match values or ranges.',
      });
  });

/** `POST /broadcasts/{id}/retry`: a change resumes with the count of passes it has left. */
export const RetryQuerySchema = z.object({
  expectCount: z.coerce.number().int().nonnegative().optional(),
});

/** `POST /broadcasts/{id}/undo`: a silent child run restores items still at the run's value. */
export const BroadcastUndoResultSchema = z.object({
  id: IdSchema,
  parentId: IdSchema,
  /** Items the undo restores: the run's updates, less the ones it has found changed since. */
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
  /** True when the counts come from the 200 newest passes and who is told is a guess: say "from the 200 newest". */
  estimated: z.boolean().optional(),
});
