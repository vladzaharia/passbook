import { z } from 'zod';
import { IdSchema, PreviewBatchQuerySchema } from '../../../shared/contracts/index.ts';

/** A selected organization scopes access to shared templates for tenant sessions. */
export const TemplateScopeQuerySchema = z.object({ orgId: IdSchema.optional() });

export const ScopedPreviewBatchQuerySchema = PreviewBatchQuerySchema.extend(
  TemplateScopeQuerySchema.shape,
);
