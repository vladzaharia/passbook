import { z } from 'zod';
import { IdSchema } from './common.ts';
import { type PassFilter, PassFilterSchema } from './pass-selection.ts';

// Saved views of the passes list: a name and the filter it applies. Kept per organization.

export const PASS_VIEWS_MAX = 20;

const isAddress = (v: string) => v.includes('@');

/** True when the filter holds something that looks like an email address: `holderEmail`, `q` or a match value. */
export function filterHasAddress(f: PassFilter): boolean {
  return (
    f.holderEmail !== undefined ||
    (f.q !== undefined && isAddress(f.q)) ||
    (f.match ?? []).some((c) =>
      'values' in c ? c.values.some(isAddress) : 'value' in c && isAddress(c.value),
    )
  );
}

/** The filter with every address-looking value hidden, for an audit entry. */
export function maskAddresses(f: PassFilter): PassFilter {
  const hide = (v: string) => (isAddress(v) ? '[hidden]' : v);
  return {
    ...f,
    ...(f.holderEmail !== undefined ? { holderEmail: '[hidden]' } : {}),
    ...(f.q !== undefined ? { q: hide(f.q) } : {}),
    ...(f.match
      ? {
          match: f.match.map((c) =>
            'values' in c
              ? { ...c, values: c.values.map(hide) }
              : 'value' in c
                ? { ...c, value: hide(c.value) }
                : c,
          ),
        }
      : {}),
  };
}

export const PassViewSchema = z.strictObject({
  /** Chosen by the client; unique within the list. */
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  name: z.string().trim().min(1).max(40),
  // No holder address is stored: it would outlive an erasure of the holder.
  filter: PassFilterSchema.refine((f) => !filterHasAddress(f), {
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
