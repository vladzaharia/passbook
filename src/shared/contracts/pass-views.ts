import { z } from 'zod';
import { IdSchema } from './common.ts';
import { PassFilterSchema } from './pass-selection.ts';

// Saved views of the passes list: a name and the filter it applies. Kept per organization.

export const PASS_VIEWS_MAX = 20;

export const PassViewSchema = z.strictObject({
  /** Chosen by the client; unique within the list. */
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  name: z.string().trim().min(1).max(40),
  // No holder address is stored: it would outlive an erasure of the holder.
  filter: PassFilterSchema.refine((f) => f.holderEmail === undefined, {
    message: 'A view cannot hold an email address.',
    path: ['holderEmail'],
  }),
});
export type PassView = z.infer<typeof PassViewSchema>;

export const PassViewListSchema = z.object({
  items: z.array(PassViewSchema).max(PASS_VIEWS_MAX),
  /** Send it back with a save: a stale one answers 409 `VIEWS_CHANGED`. 0 when nothing is stored. */
  revision: z.number().int().min(0),
});

export const PassViewsQuerySchema = z.object({ orgId: IdSchema.optional() });
export const PutPassViewsSchema = PassViewListSchema.extend({ orgId: IdSchema.optional() }).refine(
  (b) => new Set(b.items.map((v) => v.id)).size === b.items.length,
  { message: 'Each view needs its own id.', path: ['items'] },
);
