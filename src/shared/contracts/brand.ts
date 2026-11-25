import { z } from 'zod';
import { IdSchema } from './common.ts';
import { type BrandMark, BrandMarkSchema } from './orgs.ts';

/** Web logo rules: PNG only, no animation. Transparent is fine. */
export const WEB_LOGO = {
  maxBytes: 512 * 1024,
  maxWidth: 1024,
  maxHeight: 512,
  minSide: 16,
} as const;

const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** The org's brand kit as every holder surface sees it. */
export const BrandKitSchema = z.object({
  orgId: IdSchema,
  name: z.string(),
  accent: HexColorSchema.nullable(),
  /** Same-origin and content-addressed: `/brand/{orgId}/{sha}.png`. */
  webLogo: z.object({ url: z.string(), w: z.number().int(), h: z.number().int() }).nullable(),
  supportEmail: z.string().nullable(),
  supportUrl: z.string().nullable(),
  /** The level holders see: the chosen one when the plan allows it, else the nearest allowed with more PassBook. */
  mark: BrandMarkSchema,
  /** What the org chose; differs from `mark` when its plan does not allow that level. */
  markChosen: BrandMarkSchema,
  markAllowed: z.array(BrandMarkSchema),
  configRevision: z.number().int(),
});
export type BrandKit = z.infer<typeof BrandKitSchema>;

/**
 * The org's brand as every holder surface draws it: pages, bundle, join, print, error shells,
 * emails and the scanner. One loader, so no surface has its own idea of the logo, accent or mark.
 */
export interface OrgBrand {
  orgId: string;
  name: string;
  /** Hex; null follows the platform accent. */
  accent: string | null;
  /** The web logo: a same-origin path `/brand/{orgId}/{sha}.png` and its pixel size. */
  logo: { path: string; w: number; h: number } | null;
  supportEmail: string | null;
  supportUrl: string | null;
  mark: BrandMark;
}

export const BrandOrgQuerySchema = z.object({ orgId: IdSchema.optional() });

/** `accent: null` clears it. */
export const UpdateBrandKitSchema = z.object({
  accent: HexColorSchema.nullable().optional(),
  mark: BrandMarkSchema.optional().describe(
    'Refused with BRAND_MARK_NOT_ALLOWED when the plan does not allow it (`markAllowed`).',
  ),
  configRevision: z.number().int().optional(),
});

/** One PNG (base64) of at most 512 KB. */
export const UploadWebLogoSchema = z.object({
  png: z.base64().max(Math.ceil((WEB_LOGO.maxBytes * 4) / 3) + 8),
  configRevision: z.number().int().optional(),
});
export const DeleteWebLogoQuerySchema = BrandOrgQuerySchema.extend({
  configRevision: z.coerce.number().int().optional(),
});
