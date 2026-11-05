import { z } from 'zod';
import { PassListStatusSchema } from '@/shared/contracts/passes.ts';

/** Unknown or malformed values fall away instead of breaking the page. */
const opt = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

export const passListSearchSchema = z.object({
  q: opt(z.string().max(200)),
  orgId: opt(z.string()),
  templateId: opt(z.string()),
  connectionId: opt(z.string()),
  status: opt(PassListStatusSchema),
  holderState: opt(z.enum(['unassigned', 'waiting', 'owned'])),
  onDevice: opt(z.enum(['true', 'false'])),
});

export const newPassSearchSchema = z.object({
  orgId: opt(z.string()),
  templateId: opt(z.string()),
});

export const passDetailSearchSchema = z.object({
  tab: opt(
    z.enum([
      'fields',
      'holder',
      'devices',
      'sync',
      'images',
      'delivery',
      'versions',
      'connection',
      'activity',
    ]),
  ),
  v: opt(z.coerce.number().int()),
});
