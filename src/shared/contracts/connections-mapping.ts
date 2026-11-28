import { z } from 'zod';
import { JsonSchema } from './common.ts';

export const MappingEntrySchema = z.object({
  from: z.string().max(500),
  transform: z
    .object({
      kind: z.enum(['enum', 'bool-status', 'date', 'constant', 'trim', 'upper', 'lower', 'join']),
      options: z.record(z.string(), JsonSchema).optional(),
    })
    .optional(),
});
export const MappingSchema = z.record(z.string(), MappingEntrySchema);

/** The sender recipes of the webhook-push connector; fixed once a connection exists. */
export const RecipeIdSchema = z.enum([
  'custom',
  'shopify-orders',
  'shopify-customers',
  'stripe-subscriptions',
  'stripe-payments',
  'calcom-bookings',
  'woocommerce-orders',
  'tickettailor-tickets',
]);
export type RecipeId = z.infer<typeof RecipeIdSchema>;

/** Voids the bound pass when the upstream record matches. `in` is strict equality, no case folding. */
export const VoidRuleSchema = z
  .object({
    from: z.string().min(1).max(500),
    op: z.enum(['in', 'present']),
    values: z
      .array(z.union([z.string().max(200), z.number(), z.boolean()]))
      .min(1)
      .max(20)
      .optional(),
  })
  .refine((r) => (r.op === 'in') === (r.values !== undefined), {
    path: ['values'],
    message: 'Only "is one of" takes values.',
  });
export type VoidRule = z.infer<typeof VoidRuleSchema>;
export const VoidWhenSchema = z.array(VoidRuleSchema).max(8);

/** Seconds the previous webhook secret stays valid after a replacement. 0 drops it at once. */
export const SecretOverlapSchema = z.union([
  z.literal(0),
  z.literal(3600),
  z.literal(86_400),
  z.literal(604_800),
]);
