import { z } from 'zod';
import { JsonSchema } from './common.ts';

export const SettingScopeSchema = z.union([z.literal('platform'), z.string().regex(/^org:.+$/)]);
export const SettingEntrySchema = z.object({
  scope: SettingScopeSchema,
  key: z.string(),
  value: JsonSchema,
  default: JsonSchema.optional(),
  updatedAt: z.number().int().nullable(),
  updatedBy: z.string().nullable(),
});
export const SettingsListQuerySchema = z.object({ scope: SettingScopeSchema.default('platform') });
export const SettingsListSchema = z.object({
  items: z.array(SettingEntrySchema),
  /** Read-only: managed in Polaris ID. */
  oidc: z.object({
    issuer: z.string(),
    adminGroup: z.string().nullable(),
    userGroup: z.string().nullable(),
  }),
});
export const UpdateSettingsSchema = z.object({
  scope: SettingScopeSchema.default('platform'),
  values: z.record(z.string(), JsonSchema),
});
/** What turning a sign-in method off would cost: active users who can only sign in by email. */
export const SettingsImpactSchema = z.object({ emailOnlyUsers: z.number().int() });
