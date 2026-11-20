import { z } from 'zod';
import { IdSchema, JsonSchema, ModeSchema, pageOf, TimestampSchema } from './common.ts';
import { MappingEntrySchema, MappingSchema } from './connections.ts';

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

export const PassImportPlanSchema = z
  .strictObject({
    mapping: MappingSchema,
    holderEmail: MappingEntrySchema.nullable(),
    externalId: MappingEntrySchema.nullable(),
    match: PassImportMatchSchema,
    keepManual: z.boolean().default(false),
    save: z.boolean().default(true),
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
});
export const CheckPassImportSchema = z.strictObject({ plan: PassImportPlanSchema });
export const PassImportCommitSchema = z.strictObject({
  skipInvalid: z.boolean().default(false),
  email: z.boolean().default(false),
});

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
  code: z.string().max(64),
  message: z.string().max(200),
  severity: z.enum(['error', 'warning']),
});

const count = z.number().int().nonnegative();

export const PassImportCountsSchema = z.object({
  rows: count,
  create: count,
  update: count,
  unchanged: count,
  errors: count,
  warnings: count,
  emailable: count,
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
  nextCursor: z.string().nullable(),
});
