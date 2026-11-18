import { z } from 'zod';
import { IdSchema } from './common.ts';
import { SaveVersionSchema } from './template-versions.ts';

/**
 * Make a tracked copy of a template in `orgId`. Without `version` the copy is exact; with it, the
 * designer's draft. `baseVersion` is the source version the draft opened from; it defaults to the
 * version an exact copy takes, or the source's current one.
 */
export const ForkTemplateSchema = z.object({
  orgId: IdSchema,
  name: z.string().trim().min(1).max(120).optional(),
  version: SaveVersionSchema.pick({ passJson: true, manifest: true, assets: true }).optional(),
  baseVersion: z.string().min(1).max(64).optional(),
});
export type ForkTemplateRequest = z.infer<typeof ForkTemplateSchema>;
