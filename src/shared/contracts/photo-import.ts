import { z } from 'zod';
import { IdSchema } from './common.ts';

/** File names without the extension: a pass's External ID or serial. */
export const PhotoMatchRequestSchema = z.object({
  orgId: IdSchema.optional(),
  keys: z.array(z.string().trim().min(1).max(200)).min(1).max(200),
});

export const PhotoMatchSchema = z.object({
  key: z.string(),
  passId: IdSchema.nullable(),
  state: z.enum(['matched', 'none', 'ambiguous']),
});

export const PhotoMatchResponseSchema = z.object({ matches: z.array(PhotoMatchSchema) });
export type PhotoMatch = z.infer<typeof PhotoMatchSchema>;
