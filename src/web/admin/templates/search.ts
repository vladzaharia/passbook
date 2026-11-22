import { z } from 'zod';

export const templateDetailSearchSchema = z.object({
  tab: z
    .enum(['overview', 'versions', 'channels', 'manifest', 'inputs'])
    .optional()
    .catch(undefined),
  /** The version under review: opens the review dialog. */
  review: z.string().max(64).optional().catch(undefined),
  /** From the Overview path: opens Try on my phone on the draft. */
  try: z.literal('1').optional().catch(undefined),
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

/** The designer on a draft of a blueprint: `orgId` is the destination, `name` the new template's. */
export const newTemplateSearchSchema = z.object({
  blueprint: z.string().max(200).optional().catch(undefined),
  name: z.string().max(120).optional().catch(undefined),
});

export const blueprintSearchSchema = z.object({
  tab: z.enum(['overview', 'inputs']).optional().catch(undefined),
});
