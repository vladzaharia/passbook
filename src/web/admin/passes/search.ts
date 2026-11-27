import { z } from 'zod';
import { PassListStatusSchema } from '@/shared/contracts/pass-list-status.ts';

/** Unknown or malformed values fall away instead of breaking the page. */
const opt = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

export const passListSearchSchema = z.object({
  q: opt(z.string().max(200)),
  m: opt(z.string().max(2000)),
  orgId: opt(z.string()),
  /** The All scope's Organization filter: ids joined by commas. */
  orgIds: opt(z.string().max(3300)),
  templateId: opt(z.string()),
  connectionId: opt(z.string()),
  importId: opt(z.string()),
  status: opt(PassListStatusSchema),
  holderState: opt(z.enum(['unassigned', 'waiting', 'owned'])),
  onDevice: opt(z.enum(['true', 'false'])),
  noScanDays: opt(z.union([z.literal(30), z.literal(90)])),
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
