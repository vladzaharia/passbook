import { z } from 'zod';
import { IdSchema, ModeSchema, pageOf, TimestampSchema } from './common.ts';
import { WalletProviderIssuanceSchema, WalletProviderSchema } from './wallet-providers.ts';

/** A capability link to an available native wallet; installation is not known. */
export const WalletOfferSchema = z.object({
  provider: z.enum(['google', 'samsung']),
  href: z.string(),
  installation: z.literal('unknown'),
});
export type WalletOffer = z.infer<typeof WalletOfferSchema>;

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
  /** Native alternatives, independently of the Apple registration in inWallet. */
  walletOffers: z.array(WalletOfferSchema),
  /** The release gate per native wallet; a disabled one is not offered. */
  walletIssuance: z.partialRecord(WalletProviderSchema, WalletProviderIssuanceSchema).default({}),
  /** Server-checked eligibility for showing this pass's barcode. */
  presentationEligible: z.boolean().optional(),
  passJson: z.record(z.string(), z.unknown()),
  assetBaseUrl: z.string(),
  /** Image files the pass can load: template files plus per-pass overrides. */
  assetNames: z.array(z.string()),
  /** Apple device registration was reported; current installation is unknown (leaves Add all). */
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
export const MyPassListSchema = pageOf(MyPassSchema).extend({
  /** Self-removals that are waiting for older wallet credentials to retire. */
  pendingRemovals: z.array(z.object({ passId: IdSchema, transferId: IdSchema })).default([]),
  /** Waiting passes that need the issuer to reissue a non-rotatable credential. */
  reissueRequired: z
    .array(
      z.object({
        passId: IdSchema,
        orgName: z.string(),
        /** The pass's title, so the notice names it. */
        title: z.string().nullable().default(null),
        /** The org's checked support contacts. */
        support: z.object({ email: z.string().nullable(), url: z.string().nullable() }).optional(),
      }),
    )
    .default([]),
  /** Add all: one token fixes which passes each part holds, however the wallet fills meanwhile. */
  bundle: z
    .object({ token: z.string(), count: z.number().int(), parts: z.number().int() })
    .nullable()
    .default(null),
});

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

/** A self-removal is complete only after every older wallet credential is retired. */
export const RemovePassResponseSchema = z.object({
  transferId: IdSchema,
  state: z.enum(['pending', 'completed']),
});
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
const BUNDLE_TOKEN_MAX = 4096;
export const MyBundleQuerySchema = z.object({
  part: z.coerce.number().int().min(1).max(1000).default(1),
  /** The `bundle.token` of the list the holder saw; omitted, the server takes a fresh snapshot. */
  snapshot: z.string().max(BUNDLE_TOKEN_MAX).optional(),
});
