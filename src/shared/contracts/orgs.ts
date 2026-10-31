import { z } from 'zod';
import { IdSchema, pageOf, TimestampSchema } from './common.ts';

export const OrgBrandingSchema = z.object({
  accent: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  logoAsset: z.string().max(200).optional(),
  supportEmail: z.string().max(254).optional(),
  supportUrl: z.string().max(500).optional(),
});

export const OrgSchema = z.object({
  id: IdSchema,
  slug: z.string(),
  name: z.string(),
  status: z.enum(['active', 'suspended', 'deleted']),
  defaultIdentityId: IdSchema.nullable(),
  branding: OrgBrandingSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type OrgDto = z.infer<typeof OrgSchema>;

export const OrgSummarySchema = OrgSchema.extend({
  counts: z.object({
    passes: z.number().int(),
    templates: z.number().int(),
    connections: z.number().int(),
    apiKeys: z.number().int(),
  }),
});

export const CreateOrgSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  name: z.string().min(1).max(120),
  defaultIdentityId: IdSchema.nullable().optional(),
  branding: OrgBrandingSchema.optional(),
});
export const UpdateOrgSchema = CreateOrgSchema.partial().extend({
  status: z.enum(['active', 'suspended']).optional(),
});
export const OrgListSchema = pageOf(OrgSummarySchema);
