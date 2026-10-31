import { z } from 'zod';
import { JsonSchema } from './common.ts';

export const PlatformSettingsSchema = z.object({
  'oidc.trustEmail': z.boolean().default(true),
  'auth.magicLinkEnabled': z.boolean().default(true),
  'email.senderName': z.string().max(80).default('Wallet'),
  'refresh.userCooldownSeconds': z.number().int().min(5).max(3600).default(30),
  'retention.passVersionsKeep': z.number().int().min(1).max(50).default(3),
  'retention.auditDays': z.number().int().min(30).max(3650).default(365),
});
export const OrgSettingsSchema = z.object({
  'branding.accent': z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  'support.email': z.string().max(254).optional(),
  'support.url': z.string().max(500).optional(),
});

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
  /** Read-only: managed in Pocket ID. */
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
