import { z } from 'zod';
import { IdSchema, JsonSchema } from './common.ts';
import { AssetEntrySchema, TemplateDetailSchema, ValidationReportSchema } from './templates.ts';

const NameSchema = z.string().min(1).max(200);

/** A file of the new version: an existing one by content hash, or a PNG sent as base64. */
export const VersionAssetInputSchema = z.union([
  z.object({ name: NameSchema, sha1: z.string().regex(/^[0-9a-f]{40}$/) }),
  z.object({ name: NameSchema, upload: z.string().min(1) }),
]);

export const SaveVersionSchema = z.object({
  passJson: z.record(z.string(), z.unknown()),
  manifest: z.record(z.string(), JsonSchema),
  assets: z.array(VersionAssetInputSchema).max(60).default([]),
  /** Validate and build only; nothing is stored. */
  dryRun: z.boolean().default(false),
});

export const SaveVersionResponseSchema = z.object({
  saved: z.boolean(),
  /** The content version; null when the package did not get far enough to have one. */
  version: z.string().nullable(),
  /** False when an identical version already existed. */
  created: z.boolean(),
  /** The saved or previewed version has the same known pass build key as the active version. */
  displayOnly: z.boolean(),
  report: ValidationReportSchema,
  /** Files of the version, derived scales included. */
  assets: z.array(AssetEntrySchema),
  /** The pass built from the sample input; null when validation failed first. */
  passJson: z.record(z.string(), z.unknown()).nullable(),
  template: TemplateDetailSchema.nullable(),
});
export type SaveVersionRequest = z.infer<typeof SaveVersionSchema>;
export type SaveVersionResponse = z.infer<typeof SaveVersionResponseSchema>;

/** Make a template in `orgId` from a blueprint. `version` is the designer's draft; without it the copy is exact. */
export const UseBlueprintSchema = z.object({
  orgId: IdSchema,
  name: z.string().trim().min(1).max(120),
  version: SaveVersionSchema.pick({ passJson: true, manifest: true, assets: true }).optional(),
});
export type UseBlueprintRequest = z.infer<typeof UseBlueprintSchema>;

/** The designer's live check of a draft made from a blueprint; nothing is saved. */
export const UseBlueprintCheckSchema = UseBlueprintSchema.required({ version: true });
export type UseBlueprintCheckRequest = z.infer<typeof UseBlueprintCheckSchema>;
