import { z } from 'zod';
import { IdSchema, ModeSchema, pageOf, TimestampSchema } from './common.ts';

export const MyPassSchema = z.object({
  id: IdSchema,
  title: z.string().nullable(),
  subtitle: z.string().nullable(),
  templateName: z.string(),
  orgName: z.string(),
  status: z.enum(['active', 'voided']),
  /** Holders see test passes too; the card carries a Test badge. */
  mode: ModeSchema.default('live'),
  modifiedAt: TimestampSchema,
  /** When the org removed the pass from Wallet; null while it is not. */
  removedAt: TimestampSchema.nullable().default(null),
  /** The org's note with the removal, if it wrote one. */
  removalMessage: z.string().nullable().default(null),
  lastRefreshedAt: TimestampSchema.nullable(),
  refreshRequestedAt: TimestampSchema.nullable(),
  downloadUrl: z.string(),
  /** Server-checked eligibility for showing this pass's barcode. */
  presentationEligible: z.boolean().optional(),
  passJson: z.record(z.string(), z.unknown()),
  assetBaseUrl: z.string(),
  /** Image files the pass can load: template files plus per-pass overrides. */
  assetNames: z.array(z.string()),
  /** A device has registered the pass: it is in someone's Wallet (and leaves Add all). */
  inWallet: z.boolean(),
  /** One pass only: the org's checked support contacts (the voided note names them). */
  support: z
    .object({
      email: z.string().nullable(),
      url: z.string().nullable(),
      /** PassBook's own support, because the org has none. */
      platform: z.literal(true).optional(),
    })
    .optional(),
});
export const MyPassListSchema = pageOf(MyPassSchema);

export const MyEmailSchema = z.object({
  email: z.string(),
  verifiedAt: TimestampSchema.nullable(),
  verifiedVia: z.enum(['magic_link', 'oidc', 'admin']).nullable(),
  primary: z.boolean(),
});
export const MyEmailListSchema = z.object({ items: z.array(MyEmailSchema) });
export const AddEmailRequestSchema = z.object({ email: z.string().max(254) });
/** POST /api/v1/me/emails/{email}/primary: sign-in emails go to this verified address. */
export const MyEmailParamSchema = z.object({ email: z.string().max(254) });

export const MySessionSchema = z.object({
  id: IdSchema,
  createdAt: TimestampSchema,
  lastSeenAt: TimestampSchema,
  userAgent: z.string().nullable(),
  current: z.boolean(),
});
export const MySessionListSchema = z.object({ items: z.array(MySessionSchema) });

/** Adds an email and sends a verification magic link (purpose verify_email). */
export const RemovePassResponseSchema = z.object({ ok: z.literal(true) });
export const RefreshResponseSchema = z.object({
  accepted: z.literal(true),
  requestedAt: TimestampSchema,
  /** Seconds before the next refresh is accepted (settings refresh.userCooldownSeconds). */
  cooldownSeconds: z.number().int(),
});

/** GET /api/v1/me/passes.pkpasses?part=N: my active passes as .pkpasses bundles of up to 10. */
export const MY_PASSES_BUNDLE_PATH = '/api/v1/me/passes.pkpasses';
export const MY_PASSES_BUNDLE_SIZE = 10;
/** Response header with the number of bundles (parts) available. */
export const MY_PASSES_BUNDLE_PARTS_HEADER = 'x-bundle-parts';
export const MyBundleQuerySchema = z.object({
  part: z.coerce.number().int().min(1).max(1000).default(1),
});
