import { z } from 'zod';

/** Unknown or malformed values fall away instead of breaking the page. */
const opt = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

export const passListSearchSchema = z.object({
  q: opt(z.string().max(200)),
  orgId: opt(z.string()),
  templateId: opt(z.string()),
  connectionId: opt(z.string()),
  status: opt(z.enum(['active', 'voided'])),
  holderState: opt(z.enum(['unassigned', 'waiting', 'owned'])),
});
export type PassListSearch = z.infer<typeof passListSearchSchema>;

export const passDetailSearchSchema = z.object({
  tab: opt(
    z.enum([
      'fields',
      'holder',
      'images',
      'delivery',
      'versions',
      'connection',
      'devices',
      'activity',
    ]),
  ),
  v: opt(z.coerce.number().int()),
});
