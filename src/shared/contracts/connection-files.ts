import { z } from 'zod';
import { IdSchema, pageOf, TimestampSchema } from './common.ts';

/** What a file-upload connection accepts. The parser is told these; the route body cap sits above `bytes`. */
export const CONNECTION_FILE_LIMITS = {
  bytes: 5 * 1024 * 1024,
  rows: 10_000,
  columns: 100,
  cellChars: 2_000,
  headerChars: 200,
} as const;
/** Base64 of the largest file; a UTF-8 text never needs more characters than bytes. */
const CONTENT_MAX = Math.ceil(CONNECTION_FILE_LIMITS.bytes / 3) * 4;
const PREVIEW_ROWS = 20;
const CELL_PREVIEW = 80;
const EXAMPLES = 5;

/** RFC 6901, strict: empty, or `/`-led segments with `~0` and `~1` escapes. */
export const JsonPointerSchema = z
  .string()
  .max(500)
  .regex(/^(?:\/(?:[^~/]|~[01])*)*$/, 'Not a JSON pointer.');

/** A source value's kind, as field chips show it. */
export const SourceFieldTypeSchema = z.enum([
  'text',
  'number',
  'boolean',
  'date',
  'email',
  'url',
  'list',
]);

export const ConnectionFileFormatSchema = z.enum(['csv', 'xlsx', 'json', 'ndjson']);
export type ConnectionFileFormat = z.infer<typeof ConnectionFileFormatSchema>;
/** draft → current (rev 1); pending → current → superseded; pending → discarded; draft → expired. */
export const ConnectionFileStateSchema = z.enum([
  'draft',
  'pending',
  'current',
  'superseded',
  'expired',
  'discarded',
]);

const SheetSchema = z.string().min(1).max(100);

/** A file as uploaded: `utf8` for CSV, JSON and NDJSON, `base64` for XLSX. The format is sniffed from the bytes. */
export const UploadConnectionFileSchema = z.object({
  /** Shown back to admins; never logged. */
  name: z.string().min(1).max(200),
  content: z.string().min(1).max(CONTENT_MAX),
  encoding: z.enum(['utf8', 'base64']),
  /** XLSX: the sheet to read. Default: the first non-empty one. */
  sheet: SheetSchema.optional(),
  /** JSON: where the records array sits. Default: the detected one. */
  recordsPointer: JsonPointerSchema.optional(),
});
/** Sessions say which organization; a key bound to one needs no hint. */
export const UploadConnectionFileQuerySchema = z.object({ orgId: IdSchema.optional() });
/** Re-reads a draft's stored source with another sheet or records array. */
export const UpdateConnectionFileSchema = z.object({
  sheet: SheetSchema.optional(),
  recordsPointer: JsonPointerSchema.optional(),
});
/** `apply=true` applies the new revision and starts its sync in the same call. */
export const UploadConnectionRevisionQuerySchema = z.object({
  apply: z.enum(['true', 'false']).optional(),
});

export const ConnectionFileColumnSchema = z.object({
  pointer: JsonPointerSchema,
  label: z.string().max(200),
  type: SourceFieldTypeSchema,
  samples: z.array(z.string().max(CELL_PREVIEW)).max(3),
  /** Rows with no value here: skipped if this is the ID column. */
  blanks: z.number().int().nonnegative(),
  /** Rows repeating an earlier row's value: skipped if this is the ID column. */
  duplicates: z.number().int().nonnegative(),
});

/** A parsed upload not yet bound to a connection (`POST /connections/uploads`). */
export const ConnectionFileSchema = z.object({
  id: IdSchema,
  orgId: IdSchema,
  state: ConnectionFileStateSchema,
  name: z.string().max(200),
  format: ConnectionFileFormatSchema,
  /** XLSX sheets in workbook order; empty for other formats. */
  sheets: z.array(z.string().max(100)).max(200),
  sheet: z.string().max(100).nullable(),
  recordsPointer: JsonPointerSchema.nullable(),
  bytes: z.number().int().nonnegative(),
  rows: z.number().int().nonnegative(),
  columns: z.array(ConnectionFileColumnSchema).max(CONNECTION_FILE_LIMITS.columns),
  /** The header and the first rows, cells cut short. */
  preview: z.object({
    header: z
      .array(z.string().max(CONNECTION_FILE_LIMITS.headerChars))
      .max(CONNECTION_FILE_LIMITS.columns),
    rows: z
      .array(z.array(z.string().max(CELL_PREVIEW)).max(CONNECTION_FILE_LIMITS.columns))
      .max(PREVIEW_ROWS),
  }),
  /** Column pointers that could name each row: unique and never blank first, then by name. */
  idCandidates: z.array(JsonPointerSchema).max(CONNECTION_FILE_LIMITS.columns),
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema.nullable(),
});

const RefsSchema = z.array(z.string().max(200)).max(EXAMPLES);
/** Against the revision that was current at upload. */
export const ConnectionFileDiffSchema = z.object({
  added: z.number().int().nonnegative(),
  changed: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  /** A few refs of each kind; empty once the file is deleted. */
  examples: z.object({ added: RefsSchema, changed: RefsSchema, removed: RefsSchema }),
});

/** One upload of a connection's file. */
export const ConnectionFileRevisionSchema = z.object({
  id: IdSchema,
  connectionId: IdSchema,
  revision: z.number().int().positive(),
  state: ConnectionFileStateSchema,
  name: z.string().max(200),
  format: ConnectionFileFormatSchema,
  sheet: z.string().max(100).nullable(),
  bytes: z.number().int().nonnegative(),
  rows: z.number().int().nonnegative(),
  /** Rows left out: no ID, or an ID an earlier row has. */
  skipped: z.object({
    noId: z.number().int().nonnegative(),
    duplicate: z.number().int().nonnegative(),
  }),
  /** Null for revision 1. */
  diff: ConnectionFileDiffSchema.nullable(),
  /** A sync finished applying this revision. */
  applied: z.boolean(),
  /** The user or API key that uploaded it. */
  createdBy: IdSchema.nullable(),
  createdByName: z.string().max(200).nullable(),
  createdAt: TimestampSchema,
  /** When an unapplied pending revision is discarded. */
  expiresAt: TimestampSchema.nullable(),
  supersededAt: TimestampSchema.nullable(),
});
/** Newest first. */
export const ConnectionFileRevisionListSchema = pageOf(ConnectionFileRevisionSchema);

/** `unchanged`: the bytes match the current revision and nothing was created. */
export const ConnectionFileUploadResultSchema = z.discriminatedUnion('unchanged', [
  ConnectionFileRevisionSchema.extend({
    unchanged: z.literal(false),
    /** The sync that applies it, with `apply=true`. */
    runId: IdSchema.optional(),
  }),
  z.object({ unchanged: z.literal(true) }),
]);
/** The applied revision and the sync that applies it. */
export const ApplyConnectionFileResponseSchema = z.object({
  file: ConnectionFileRevisionSchema,
  runId: IdSchema,
  workflowInstanceId: z.string(),
});
