import { z } from 'zod';
import {
  IdSchema,
  ModeSchema,
  OrgIdSchema,
  PageQuerySchema,
  PlainLineSchema,
  pageOf,
  TimestampSchema,
} from './common.ts';

/** Apple's .pkpasses limit; a bundle never exceeds it. */
export const BUNDLE_MAX_PASSES = 10;

export const CreateBundleSchema = z.object({
  orgId: OrgIdSchema,
  passIds: z.array(IdSchema).min(1).max(BUNDLE_MAX_PASSES),
  name: PlainLineSchema(80),
  /** Whoever the link is for; `sendEmail` mails it there. */
  holderEmail: z.string().max(254).optional(),
  sendEmail: z.boolean().optional(),
});

export const BundlePassSchema = z.object({
  id: IdSchema,
  title: z.string(),
  status: z.enum(['active', 'voided']),
});

export const BundleSchema = z.object({
  id: IdSchema,
  orgId: OrgIdSchema,
  mode: ModeSchema,
  name: z.string(),
  /** The capability link, `/b/<token>` on the public origin. */
  url: z.string(),
  holderEmail: z.string().nullable(),
  passes: z.array(BundlePassSchema),
  createdAt: TimestampSchema,
  linkRotatedAt: TimestampSchema.nullable(),
});
export type BundleDto = z.infer<typeof BundleSchema>;

export const BundleListQuerySchema = PageQuerySchema.extend({
  orgId: OrgIdSchema.optional(),
  /** Only the bundles holding this pass. */
  passId: IdSchema.optional(),
});
export const BundleListSchema = pageOf(BundleSchema);

export const SendBundleEmailSchema = z.object({ to: z.string().max(254).optional() });

export const PublicBundleParamSchema = z.object({ token: z.string().min(1).max(200) });
export const PublicBundlePassParamSchema = PublicBundleParamSchema.extend({
  passId: IdSchema,
});
export const PublicBundleAssetParamSchema = PublicBundlePassParamSchema.extend({
  name: z.string().min(1).max(120),
});
