import { z } from 'zod';
import {
  IdSchema,
  JsonSchema,
  ModeSchema,
  PlainLineSchema,
  pageOf,
  TimestampSchema,
} from './common.ts';
import {
  FieldChangeSchema,
  MappingSuggestionSchema,
  PlanMappingEntrySchema,
  PlanMappingSchema,
} from './issuing.ts';

const count = z.number().int().nonnegative();

export const PASS_IMPORT_MAX_ROWS = 2000;
export const PASS_IMPORT_MAX_BYTES = 2_000_000;
export const PASS_IMPORT_MAX_COLUMNS = 100;
export const PASS_IMPORT_MAX_CELL = 2000;
export const PASS_IMPORT_PREVIEWS = 20;
export const PASS_IMPORT_PROBLEMS = 100;

export const PassImportSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('file'),
    name: z.string().min(1).max(200),
    csv: z.string().min(1).max(PASS_IMPORT_MAX_BYTES),
  }),
  /** https only; safe-fetch refuses private hosts. */
  z.strictObject({
    kind: z.literal('url'),
    url: z
      .url()
      .max(2000)
      .refine((u) => u.startsWith('https://'), 'Use an https link.'),
  }),
]);

export const PassImportMatchSchema = z.enum(['externalId', 'email', 'none']);

/** Cell fixes from the check, by spreadsheet row then column pointer. */
export const PASS_IMPORT_MAX_OVERRIDES = 200;
export const PassImportOverridesSchema = z
  .record(
    z.string().regex(/^[1-9]\d{0,5}$/),
    z.record(z.string().max(500), z.string().max(PASS_IMPORT_MAX_CELL)),
  )
  .refine(
    (o) =>
      Object.values(o).reduce((n, cells) => n + Object.keys(cells).length, 0) <=
      PASS_IMPORT_MAX_OVERRIDES,
    `Fix at most ${PASS_IMPORT_MAX_OVERRIDES} cells in place; fix the rest in the file.`,
  );

export const PassImportPlanSchema = z
  .strictObject({
    mapping: PlanMappingSchema,
    holderEmail: PlanMappingEntrySchema.nullable(),
    externalId: PlanMappingEntrySchema.nullable(),
    match: PassImportMatchSchema,
    keepManual: z.boolean().default(false),
    save: z.boolean().default(true),
    overrides: PassImportOverridesSchema.optional(),
  })
  .refine((p) => p.match !== 'externalId' || p.externalId !== null, {
    path: ['externalId'],
    message: 'Map an External ID column to match on it.',
  })
  .refine((p) => p.match !== 'email' || p.holderEmail !== null, {
    path: ['holderEmail'],
    message: 'Map a Holder email column to match on it.',
  });

export const CreatePassImportSchema = z.strictObject({
  templateId: IdSchema,
  source: PassImportSourceSchema,
  plan: PassImportPlanSchema.optional(),
  /** `auto`: with no plan, map the file from the template (or a saved mapping of the same columns). */
  mapping: z.literal('auto').optional(),
});
export const CheckPassImportSchema = z.strictObject({ plan: PassImportPlanSchema });
/** Commit email: `held` waits out the undo window. The console holds; the API sends now. */
export const PASS_IMPORT_HOLD_DEFAULT_MS = 5 * 60_000;
export const PASS_IMPORT_HOLD_MAX_MS = 24 * 60 * 60_000;
export const PassImportEmailSendSchema = z.discriminatedUnion('send', [
  z.strictObject({ send: z.literal('now') }),
  z.strictObject({
    send: z.literal('held'),
    holdMs: z
      .number()
      .int()
      .min(60_000)
      .max(PASS_IMPORT_HOLD_MAX_MS)
      .default(PASS_IMPORT_HOLD_DEFAULT_MS),
  }),
]);

/** `POST /pass-imports/{id}/undo`. Kept passes were edited or scanned since the import. */
export const PassImportUndoResultSchema = z.object({
  state: z.enum(['running', 'done', 'failed']),
  removed: count,
  restored: count,
  keptTotal: count,
  kept: z.array(z.object({ passId: IdSchema, code: z.string().max(64) })).max(PASS_IMPORT_PROBLEMS),
  /** Held emails that will not go out. */
  emailsCancelled: count,
  /** Updated rows no undo can restore (the import kept no earlier values). */
  unrevertable: count.optional(),
});

export const PassImportCommitSchema = z.strictObject({
  skipInvalid: z.boolean().default(false),
  /** `true` sends now; `{send:'held', holdMs}` waits out the undo window; `false` sends nothing. */
  email: z.union([z.boolean(), PassImportEmailSendSchema]).default(false),
});
export const PassImportUndoBodySchema = z.strictObject({});

export const PassImportStateSchema = z.enum([
  'mapping',
  'checking',
  'ready',
  'committing',
  'done',
  'failed',
  'stale',
  'expired',
  'discarded',
]);
export type PassImportState = z.infer<typeof PassImportStateSchema>;

export const PassImportColumnSchema = z.object({
  pointer: z.string().max(500),
  label: z.string().max(200),
  samples: z.array(z.string().max(80)).max(3),
});

export const PassImportProblemSchema = z.object({
  /** The spreadsheet row: the header is row 1. */
  row: z.number().int().min(2),
  column: z.string().max(200).nullable(),
  field: z.string().max(64).nullable(),
  /** The field as the form labels it (`x-label`), for the operator. */
  label: z.string().max(200).nullable().optional(),
  /** The offending cell as written, up to 200 characters: the organization's own data, shown to its operator only. */
  value: z.string().max(200).nullable().optional(),
  code: z.string().max(64),
  message: z.string().max(200),
  severity: z.enum(['error', 'warning']),
});

export const PassImportCountsSchema = z.object({
  rows: count,
  create: count,
  update: count,
  unchanged: count,
  errors: count,
  warnings: count,
  emailable: count,
  /** Rows with errors by what they would do once fixed. */
  errorsCreate: count.optional(),
  errorsUpdate: count.optional(),
});

export const PassImportProgressSchema = z.object({
  done: count,
  created: count,
  updated: count,
  unchanged: count,
  failed: count,
  /** Creates skipped because the plan's pass limit was reached. */
  skipped: count.default(0),
  notEmailed: count,
  removed: count,
});

export const PassImportSchema = z.object({
  id: IdSchema,
  templateId: IdSchema,
  templateVersion: z.string().nullable(),
  mode: ModeSchema,
  state: PassImportStateSchema,
  /** The file name, or the link's host only. */
  source: z.object({ kind: z.enum(['file', 'url']), name: z.string() }),
  columns: z.array(PassImportColumnSchema).max(PASS_IMPORT_MAX_COLUMNS),
  plan: PassImportPlanSchema.nullable(),
  counts: PassImportCountsSchema.nullable(),
  previews: z
    .array(
      z.object({
        row: z.number().int().min(2),
        action: z.enum(['create', 'update']),
        input: z.record(z.string(), JsonSchema),
      }),
    )
    .max(PASS_IMPORT_PREVIEWS),
  problems: z.array(PassImportProblemSchema).max(PASS_IMPORT_PROBLEMS),
  /** Every problem of the draft by severity; `problems` lists errors first, then warnings, capped. */
  problemTotals: z.object({ errors: count, warnings: count }),
  problemsTruncated: z.boolean(),
  emailBudget: count.nullable(),
  email: z.boolean(),
  progress: PassImportProgressSchema.nullable(),
  errorCode: z.string().nullable(),
  errorFile: z.boolean(),
  createdAt: TimestampSchema,
  checkedAt: TimestampSchema.nullable(),
  committedAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(),
  expiresAt: TimestampSchema,
  /** The template-driven suggestion for this file (`mapping: 'auto'`). */
  mapping: MappingSuggestionSchema.optional(),
  /** Held import emails go out at this time unless the import is undone first. */
  emailHoldUntil: TimestampSchema.nullable().optional(),
  /** Present once an undo was asked for. */
  undo: PassImportUndoResultSchema.optional(),
  /** Before an undo: updated rows it could not restore. */
  unrevertable: count.optional(),
});
export type PassImportDto = z.infer<typeof PassImportSchema>;

export const PassImportRowSchema = z.object({
  row: z.number().int().min(2),
  action: z.enum(['create', 'update', 'unchanged', 'error']),
  state: z.enum(['planned', 'done', 'failed', 'skipped']),
  result: z.enum(['created', 'updated', 'unchanged']).nullable(),
  passId: IdSchema.nullable(),
  externalId: z.string().nullable(),
  code: z.string().nullable(),
  message: z.string().nullable(),
  emailed: z.boolean(),
  /** An update's changed fields, labelled and formatted (`fieldChanges`). */
  changes: z.array(FieldChangeSchema).max(PASS_IMPORT_MAX_COLUMNS).optional(),
  /** What an error row would have done once fixed. */
  wouldBe: z.enum(['create', 'update']).nullable().optional(),
});

export const PassImportListQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
export const PassImportRowsQuerySchema = z.object({
  state: z.enum(['planned', 'done', 'failed', 'skipped']).optional(),
  cursor: z.string().max(512).optional(),
});
export const PassImportPageSchema = pageOf(PassImportSchema);
export const PassImportRowsPageSchema = pageOf(PassImportRowSchema);

export const PassImportRemoveSchema = z.strictObject({ cursor: z.string().max(64).nullable() });
export const PassImportRemoveResultSchema = z.object({
  removed: count,
  skipped: z.array(z.object({ passId: IdSchema, code: z.string() })),
  nextCursor: z.string().nullable(),
});

/** Email the created passes that were not emailed at commit, 50 rows a call after `cursor`. */
export const PassImportEmailRestSchema = PassImportRemoveSchema;
export const PassImportEmailRestResultSchema = z.object({
  sent: count,
  /** Held back: the day's or the holder's hourly cap, or a pass that cannot be mailed now. */
  skipped: count,
  /** Held mail a stopped run had already queued: marked emailed, not sent again and not counted in `sent`. */
  alreadyQueued: count.optional(),
  nextCursor: z.string().nullable(),
});

// Issuing at scale. Additive: the routes above validate with the v1 shapes until the import server
// and import undo take these.

/** The plan as stored and checked since issuing at scale: join entries, cell fixes. */
export const PassImportPlanV2Schema = PassImportPlanSchema;
export type PassImportPlanV2 = z.infer<typeof PassImportPlanSchema>;

/** Named mappings per template, picked by the file's headers (80% overlap), in the stored plan JSON. */
export const PASS_IMPORT_SAVED_MAX = 20;
export const MAPPING_SIGNATURE_OVERLAP = 0.8;
export const SavedImportMappingSchema = z.object({
  name: PlainLineSchema(60),
  columns: z.array(z.string().max(200)).max(PASS_IMPORT_MAX_COLUMNS),
  plan: PassImportPlanV2Schema,
  savedAt: TimestampSchema,
});
export const SavedImportMappingsSchema = z.object({
  v: z.literal(2),
  saved: z.array(SavedImportMappingSchema).max(PASS_IMPORT_SAVED_MAX),
  /** The plan of the last check that saved (the unnamed one). */
  last: PassImportPlanSchema.optional(),
});
export const SavedImportMappingsQuerySchema = z.object({
  templateId: IdSchema,
  orgId: IdSchema.optional(),
});
export const PutSavedImportMappingSchema = SavedImportMappingSchema.omit({ savedAt: true }).extend({
  templateId: IdSchema,
});
export const DeleteSavedImportMappingQuerySchema = SavedImportMappingsQuerySchema.extend({
  name: PlainLineSchema(60),
});
export const SavedImportMappingsResultSchema = z.object({
  saved: z.array(SavedImportMappingSchema).max(PASS_IMPORT_SAVED_MAX),
});
