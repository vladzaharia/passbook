import { z } from 'zod';
import { IdSchema, JsonSchema, pageOf, TimestampSchema } from './common.ts';

export const PassStyleSchema = z.enum([
  'generic',
  'posterGeneric',
  'storeCard',
  'coupon',
  'eventTicket',
  'boardingPass',
]);

export const AssetEntrySchema = z.object({
  name: z.string(),
  slot: z.string(),
  scale: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  locale: z.string().optional(),
  size: z.number().int(),
  sha1: z.string(),
  crc32: z.number().int(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
});

export const ValidationIssueSchema = z.object({
  severity: z.enum(['error', 'warning']),
  code: z.string(),
  message: z.string(),
  path: z.string().optional(),
});
export const ValidationReportSchema = z.object({
  ok: z.boolean(),
  issues: z.array(ValidationIssueSchema),
});

export const TemplateSummarySchema = z.object({
  id: IdSchema,
  orgId: IdSchema.nullable(),
  orgName: z.string().nullable(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  origin: z.enum(['baked', 'uploaded']),
  status: z.enum(['active', 'archived', 'deleted']),
  activeVersion: z.string().nullable(),
  styles: z.array(PassStyleSchema),
  passCount: z.number().int(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type TemplateSummaryDto = z.infer<typeof TemplateSummarySchema>;

export const TemplateVersionSchema = z.object({
  version: z.string(),
  createdAt: TimestampSchema,
  createdBy: IdSchema.nullable(),
  assets: z.array(AssetEntrySchema),
  report: ValidationReportSchema,
  active: z.boolean(),
  /** Live passes on this version. */
  passCount: z.number().int(),
});

export const TemplateVersionDetailSchema = TemplateVersionSchema.extend({
  manifest: JsonSchema,
  passJson: z.record(z.string(), z.unknown()),
});

export const TemplateDetailSchema = TemplateSummarySchema.extend({
  /** JSON Schema (with x-label, x-group, x-order, x-widget, x-enumLabels) for the active version. */
  inputSchema: JsonSchema,
  sample: z.record(z.string(), JsonSchema),
  manifest: JsonSchema,
  versions: z.array(TemplateVersionSchema),
  /** Live passes on a version other than the active one: what "Update N passes" moves. */
  passesOnOlderVersions: z.number().int(),
});

const BoolQuery = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

export const TemplateListQuerySchema = z.object({
  orgId: IdSchema.optional(),
  includeArchived: BoolQuery.optional(),
  origin: z.enum(['baked', 'uploaded']).optional(),
  status: z.enum(['active', 'archived']).optional(),
  /** Matches name or slug, case-insensitive. */
  q: z.string().trim().max(100).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const TemplateListSchema = pageOf(TemplateSummarySchema);

export const UploadTemplateQuerySchema = z.object({
  orgId: IdSchema.optional(),
  name: z.string().max(120).optional(),
});
export const UploadTemplateResponseSchema = z.object({
  uploadId: IdSchema,
  workflowInstanceId: z.string(),
});
export const ImportStatusSchema = z.object({
  uploadId: IdSchema,
  status: z.enum(['queued', 'running', 'complete', 'errored', 'terminated']),
  step: z.string().nullable(),
  templateId: IdSchema.nullable(),
  version: z.string().nullable(),
  report: ValidationReportSchema.nullable(),
  error: z.string().nullable(),
});

export const UploadListQuerySchema = z.object({
  orgId: IdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});
export const UploadSummarySchema = z.object({
  uploadId: IdSchema,
  name: z.string().nullable(),
  status: ImportStatusSchema.shape.status,
  templateId: IdSchema.nullable(),
  version: z.string().nullable(),
  error: z.string().nullable(),
  /** Errors and warnings in the report. */
  issues: z.number().int(),
  createdAt: TimestampSchema,
});
export const UploadListSchema = z.object({ items: z.array(UploadSummarySchema) });

export const TemplateReissueResponseSchema = z.object({
  workflowInstanceId: z.string(),
  /** Passes on older versions when the run started. */
  passes: z.number().int(),
});

export const TemplateVersionParamSchema = z.object({
  id: IdSchema,
  version: z.string().min(1).max(64),
});
export const TemplateAssetParamSchema = TemplateVersionParamSchema.extend({
  name: z.string().min(1).max(200),
});
export const DeleteTemplateResponseSchema = z.object({
  ok: z.literal(true),
  outcome: z.enum(['deleted', 'archived']),
});

/** Id of the baked template built from templates/<slug>/. */
export function bakedTemplateId(slug: string): string {
  return `baked:${slug}`;
}

export const ActivateVersionSchema = z.object({
  version: z.string(),
  rebuildPasses: z.boolean().default(false),
});
export const CloneTemplateSchema = z.object({
  orgId: IdSchema,
  name: z.string().min(1).max(120).optional(),
});
export const UpdateTemplateSchema = z.object({ orgId: IdSchema.nullable() });
export const UpdateManifestSchema = z.object({ manifest: JsonSchema });
export const PreviewRequestSchema = z.object({
  version: z.string().optional(),
  /** Preview as this org's pass: its name, colours, logo and icon. */
  orgId: IdSchema.optional(),
  input: z.record(z.string(), JsonSchema).optional(),
  locale: z.string().max(35).optional(),
});
export const PreviewResponseSchema = z.object({
  passJson: z.record(z.string(), z.unknown()),
  warnings: z.array(ValidationIssueSchema),
  assetBaseUrl: z.string(),
  /** Image files the preview can load: package files plus preview-only extras. */
  assetNames: z.array(z.string()),
});

/** One-sentence text for the `error` code of a failed import. */
export const IMPORT_ERROR_MESSAGES: Record<string, string> = {
  IMPORT_INVALID: 'The package has errors. Fix them and upload again.',
  IMPORT_FAILED: 'The import failed. Upload it again.',
  UPLOAD_MISSING: 'The upload expired. Upload it again.',
  WORKFLOW_START: 'Could not start the import. Try again.',
  TEMPLATE_BAKED: 'That name belongs to a built-in template. Use another name.',
  NOT_A_ZIP: 'The file is not a zip archive.',
  ZIP_INVALID: 'The archive is damaged or unsupported.',
  ZIP_COMPRESSION: 'The archive uses an unsupported compression.',
  ARCHIVE_TOO_LARGE: 'The archive is too large. The limit is 15 MB.',
  ENTRY_TOO_LARGE: 'A file in the archive is larger than 5 MB.',
  COMPRESSION_RATIO: 'A file in the archive expands too much.',
  TOO_MANY_ENTRIES: 'The archive has too many files.',
  PATH_DUPLICATE: 'The archive has duplicate file names.',
};

export function importErrorMessage(code: string | null): string | null {
  if (!code) return null;
  return IMPORT_ERROR_MESSAGES[code] ?? 'The import failed. Check the report and upload again.';
}
