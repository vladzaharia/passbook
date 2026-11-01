import { z } from 'zod';
import { IdSchema, PageQuerySchema, PlainLineSchema, pageOf, TimestampSchema } from './common.ts';

const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** An uploaded pass image: sha-256 of the @3x PNG and its pixel size. */
export const BrandingImageSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{64}$/),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
});
export const BrandingSlotSchema = z.enum(['logo', 'icon']);

export const OrgBrandingSchema = z.object({
  accent: HexColorSchema.optional(),
  supportEmail: z.string().max(254).optional(),
  supportUrl: z.string().max(500).optional(),
  /** pass.json backgroundColor, foregroundColor and labelColor for the org's passes. */
  passColors: z
    .object({ background: HexColorSchema, foreground: HexColorSchema, label: HexColorSchema })
    .optional(),
  /** Set by the image upload endpoint; ignored on update. */
  logo: BrandingImageSchema.optional(),
  icon: BrandingImageSchema.optional(),
  /** The logo already shows the org name, so passes leave logoText empty. */
  logoHasName: z.boolean().optional(),
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
  /** Counts stop at 100000 so a large org never costs a scan. */
  countsCapped: z.boolean(),
});

export const OrgListQuerySchema = PageQuerySchema.extend({
  /** Name or slug contains. */
  q: z.string().max(200).optional(),
});

export const CreateOrgSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  name: PlainLineSchema(120),
  defaultIdentityId: IdSchema.nullable().optional(),
  branding: OrgBrandingSchema.optional(),
});
export const UpdateOrgSchema = CreateOrgSchema.partial().extend({
  status: z.enum(['active', 'suspended']).optional(),
});
/** Suspend stops pass updates and API keys for the org; audited as org.suspend / org.reactivate. */
export const OrgStatusSchema = z.object({ status: z.enum(['active', 'suspended']) });
export const OrgListSchema = pageOf(OrgSummarySchema);

/** A PNG at @3x (base64); the @2x is derived from it when omitted. */
export const UploadBrandingImageSchema = z.object({
  x3: z.base64().max(560_000),
  x2: z.base64().max(560_000).optional(),
});
export const BrandingSlotParamSchema = z.object({ id: IdSchema, slot: BrandingSlotSchema });
