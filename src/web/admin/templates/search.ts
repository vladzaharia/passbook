import { z } from 'zod';

export const templateDetailSearchSchema = z.object({
  tab: z.enum(['overview', 'versions', 'manifest', 'inputs']).optional().catch(undefined),
});

export const templateListSearchSchema = z.object({
  q: z.string().max(100).optional().catch(undefined),
  origin: z.enum(['baked', 'uploaded']).optional().catch(undefined),
  archived: z.boolean().optional().catch(undefined),
  view: z.enum(['gallery', 'table']).optional().catch(undefined),
});
export type TemplateListSearch = z.infer<typeof templateListSearchSchema>;

export const uploadSearchSchema = z.object({
  /** "Upload version": the template the new version belongs to. */
  templateId: z.string().optional().catch(undefined),
  /** An earlier import, to show its report. */
  upload: z.string().optional().catch(undefined),
});
