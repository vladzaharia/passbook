import { z } from 'zod';
import { IdSchema } from './common.ts';
import { EntitlementKeySchema } from './entitlements.ts';

/** What a plan page lists as a feature: the plan's flags and levels, and the channels the org can use. */
export const PLAN_FEATURE_KEYS = [
  'apple',
  'wallet.google',
  'wallet.samsung',
  'print',
  'nfc',
  'api',
  'apps',
  'webhooks',
  'templates.uploads',
  'identity.own',
  'identity.managed',
] as const;
export const PlanFeatureKeySchema = z.enum(PLAN_FEATURE_KEYS);
export type PlanFeatureKey = z.infer<typeof PlanFeatureKeySchema>;

export const OrgPlanParamsSchema = z.strictObject({ id: IdSchema });

export const OrgPlanSchema = z.object({
  orgId: IdSchema,
  /** The plan id; null when the organization has no plan row. */
  preset: z.string().nullable(),
  label: z.string().nullable(),
  /** Every limit the plan sets above 0, in registry order. `used` is null where no count is kept. */
  limits: z.array(
    z.object({
      key: EntitlementKeySchema,
      limit: z.number().int().min(0).nullable().describe('Null is no limit.'),
      used: z.number().int().min(0).nullable(),
    }),
  ),
  /** What the organization can use now: the plan's, minus anything PassBook has switched off. */
  features: z.array(
    z.object({
      key: PlanFeatureKeySchema,
      level: z.string().nullable().describe('The level, for a feature that has them.'),
    }),
  ),
  /** The smallest PassBook footer the plan allows: full, quiet or none. */
  footer: z.enum(['full', 'quiet', 'none']),
});
export type OrgPlanDto = z.infer<typeof OrgPlanSchema>;
