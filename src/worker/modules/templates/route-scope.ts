import { z } from 'zod';
import { IdSchema, PreviewBatchQuerySchema } from '../../../shared/contracts/index.ts';

/** A selected organization scopes access to shared templates for tenant sessions. */
export const TemplateScopeQuerySchema = z.object({ orgId: IdSchema.optional() });

/** A stamp card's asset as one count shows it: `strip@2x.png` is the strip drawn for `stamps`. */
export const TemplateAssetQuerySchema = TemplateScopeQuerySchema.extend({
  stamps: z.coerce.number().int().min(0).max(20).optional(),
});

export const ScopedPreviewBatchQuerySchema = PreviewBatchQuerySchema.extend(
  TemplateScopeQuerySchema.shape,
);
