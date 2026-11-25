import { z } from 'zod';
import { WEB_LOGO } from './brand.ts';
import {
  ChainLevelSchema,
  ChannelLevelSchema,
  ChannelSchema,
  EffectiveChannelsSchema,
} from './channels.ts';
import { IdSchema, JsonSchema, ModeSchema, TimestampSchema } from './common.ts';
import { IdentityRunSchema, WalletIdentitySchema } from './identities.ts';
import {
  BrandingImageSchema,
  BrandingSlotSchema,
  BrandMarkSchema,
  CreateOrgSchema,
  OrgBrandingSchema,
} from './orgs.ts';
import { OrgSettingsSchema } from './settings.ts';
import { WalletEnrolmentSchema, WalletProviderSchema } from './wallet-providers.ts';

const HexColorSchema = OrgBrandingSchema.shape.accent.unwrap();
const PassColorsSchema = OrgBrandingSchema.shape.passColors.unwrap();
const ShaSchema = BrandingImageSchema.shape.sha;

/** A brand value and who set it. `passbook` is PassBook's default or placeholder. */
function valued<T extends z.ZodType>(value: T) {
  return z.object({
    value: value.nullable().describe('The value in force; null when there is none.'),
    source: ChainLevelSchema.describe('Who set it: passbook (default), org, template or pass.'),
  });
}
/** A part a template may keep its own instead of the organization's (the manifest `brand` block). */
const ownable = <T extends z.ZodType>(value: T) =>
  valued(value).extend({
    templatesOwn: z.number().int().nonnegative().describe('Templates that keep their own.'),
  });

/** The template manifest's `brand` block parts; each is `org` (default) or `template`. */
export const BrandPartSchema = z.enum(['colors', 'logo', 'icon']);
export type BrandPart = z.infer<typeof BrandPartSchema>;

export const SETUP_CHECK_CODES = [
  'BRAND_LOGO',
  'BRAND_ICON',
  'BRAND_COLORS',
  'BRAND_CONTRAST',
  'ACCENT_CONTRAST',
  'SUPPORT_MISSING',
  'APPLE_SHARED_ID',
  'APPLE_ID_FAILED',
  'APPLE_ID_EXPIRING',
  'APPLE_PUSH',
  'WALLET_ACCOUNT',
  'NO_CHANNEL',
  'TEMPLATE_BRAND_OWN',
] as const;
export const SetupCheckCodeSchema = z.enum(SETUP_CHECK_CODES);
export type SetupCheckCode = z.infer<typeof SetupCheckCodeSchema>;

/** Stable fix ids. The console maps each to a control; an API caller maps it to an endpoint. */
export const SETUP_FIX_ACTIONS = [
  'upload_logo',
  'upload_icon',
  'use_logo_colors',
  'edit_colors',
  'fix_contrast',
  'fix_accent',
  'edit_support',
  'start_apple_managed',
  'retry_identity_run',
  'renew_identity',
  'replace_certificate',
  'check_push',
  'setup_wallet_account',
  'allow_channel',
  'review_template',
] as const;
export const SetupFixActionSchema = z.enum(SETUP_FIX_ACTIONS);
export type SetupFixAction = z.infer<typeof SetupFixActionSchema>;

export const SetupFixSchema = z.object({
  action: SetupFixActionSchema,
  target: z.string().optional().describe('The channel, template, identity or run it acts on.'),
});
export type SetupFix = z.infer<typeof SetupFixSchema>;

export const SetupCheckSchema = z.object({
  code: SetupCheckCodeSchema,
  /** warn and error count as to-dos; info never does. */
  level: z.enum(['error', 'warn', 'info']),
  /** The page section that holds the fix. */
  area: z.enum(['brand', 'support', 'channels']),
  message: z.string().describe('One sentence, in English.'),
  channel: ChannelSchema.optional(),
  templateIds: z.array(IdSchema).optional().describe('Templates it touches; absent: every one.'),
  fix: SetupFixSchema,
});
export type SetupCheck = z.infer<typeof SetupCheckSchema>;

/** One channel for the whole org, in the view's mode. */
export const SetupChannelSchema = z.object({
  on: z.boolean().describe('No level from PassBook to Organization stops it.'),
  allowed: z.boolean().describe("The organization's Allowed switch."),
  levels: z
    .array(ChannelLevelSchema)
    .describe('PassBook, Plan, Organization, then Template over all templates.'),
  templates: z.object({
    on: z.number().int().nonnegative(),
    /** Off by policy or without a design for the channel. */
    off: z.number().int().nonnegative(),
    never: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  account: WalletEnrolmentSchema.optional().describe('Google and Samsung: the enrollment.'),
});
export type SetupChannel = z.infer<typeof SetupChannelSchema>;

/** A template as the page lists it under each channel and brand part. */
export const SetupTemplateSchema = z.object({
  id: IdSchema,
  name: z.string(),
  ownBrand: z.array(BrandPartSchema).describe("Parts it keeps instead of the organization's."),
  placeholders: z
    .array(BrandingSlotSchema)
    .describe("Slots whose own image is PassBook's placeholder."),
  channels: EffectiveChannelsSchema.describe("The template's own view, before pass overrides."),
});
export type SetupTemplate = z.infer<typeof SetupTemplateSchema>;

export const PassSetupBrandSchema = z.object({
  name: valued(z.string()),
  logo: ownable(BrandingImageSchema),
  icon: ownable(BrandingImageSchema),
  webLogo: valued(BrandingImageSchema).extend({
    sameAsLogo: z.boolean().describe('Holder pages and emails use the pass logo.'),
  }),
  passColors: ownable(PassColorsSchema),
  logoHasName: valued(z.boolean()),
  accent: valued(HexColorSchema),
  mark: z.object({
    chosen: BrandMarkSchema,
    effective: BrandMarkSchema.describe(
      'What holders see: the chosen one when the plan allows it, else the nearest allowed with more PassBook.',
    ),
    allowed: z.array(BrandMarkSchema),
  }),
  support: z.object({ email: valued(z.string()), url: valued(z.string()) }),
  email: z.object({ fromName: valued(z.string()), buddy: z.boolean() }),
});

export const PassSetupAppleSchema = z.object({
  identity: WalletIdentitySchema.nullable().describe(
    "The org's own identity new passes sign with; null: PassBook's shared one.",
  ),
  sharedIdentifier: z.string().describe("PassBook's shared pass type ID."),
  push: z.enum(['unknown', 'healthy', 'failing']).describe('Push health of the signing identity.'),
  run: IdentityRunSchema.nullable().describe("The org's latest provision or rotate run."),
  managedAllowed: z.boolean().describe('The plan includes a managed pass type ID.'),
  passesOnShared: z.number().int().nonnegative().describe('Passes signed with the shared ID.'),
});

/** GET /api/v1/orgs/{orgId}/pass-setup: brand, channels and accounts in the caller's mode. */
export const PassSetupSchema = z.object({
  orgId: IdSchema,
  mode: ModeSchema,
  revision: z.string().describe('Send it back as expectedRevision.'),
  passCount: z.number().int().nonnegative().describe("The mode's passes; stops at 100000."),
  brand: PassSetupBrandSchema,
  channels: z.record(ChannelSchema, SetupChannelSchema),
  apple: PassSetupAppleSchema,
  templates: z.array(SetupTemplateSchema),
  checks: z.array(SetupCheckSchema),
});
export type PassSetup = z.infer<typeof PassSetupSchema>;

/** A staged upload from POST /orgs/{orgId}/brand-assets; the save that names it commits it. */
const StagedAssetRefSchema = z.strictObject({
  sha: ShaSchema,
  version: ShaSchema.optional().describe('The version the upload answered; absent: the sha.'),
});

/** PATCH /api/v1/orgs/{orgId}/pass-setup. Absent leaves a value; `null` clears it. */
export const PassSetupPatchSchema = z.strictObject({
  expectedRevision: z.string().min(1).max(200),
  brand: z
    .strictObject({
      name: CreateOrgSchema.shape.name,
      logo: StagedAssetRefSchema.nullable(),
      icon: StagedAssetRefSchema.nullable(),
      webLogo: StagedAssetRefSchema.nullable(),
      webLogoSameAsLogo: z.boolean(),
      passColors: PassColorsSchema.nullable(),
      logoHasName: z.boolean(),
      accent: HexColorSchema.nullable(),
      mark: BrandMarkSchema,
      support: z
        .strictObject({
          email: OrgSettingsSchema.shape['support.email'].unwrap().nullable(),
          url: OrgSettingsSchema.shape['support.url'].unwrap().nullable(),
        })
        .partial(),
      email: z
        .strictObject({
          fromName: OrgSettingsSchema.shape['email.fromName'].unwrap().nullable(),
          buddy: z.boolean(),
        })
        .partial(),
    })
    .partial()
    .optional(),
  channels: z
    .partialRecord(ChannelSchema, z.enum(['allowed', 'blocked']))
    .optional()
    .describe("The org's Allowed switch per channel, in the caller's mode."),
});
export type PassSetupPatch = z.infer<typeof PassSetupPatchSchema>;

export const PassSetupPatchQuerySchema = z.object({
  dryRun: z
    .enum(['true', 'false'])
    .optional()
    .describe('true: answer with the change, write nothing.'),
});

/** What a diff row names; the review dialog labels it from PASS_SETUP_COPY.fields. */
export const PASS_SETUP_FIELDS = [
  'brand.name',
  'brand.logo',
  'brand.icon',
  'brand.webLogo',
  'brand.webLogoSameAsLogo',
  'brand.passColors',
  'brand.logoHasName',
  'brand.accent',
  'brand.mark',
  'brand.support.email',
  'brand.support.url',
  'brand.email.fromName',
  'brand.email.buddy',
  'channels.mobile',
  'channels.apple',
  'channels.google',
  'channels.samsung',
  'channels.paper',
  'channels.nfc',
] as const;
export const PassSetupFieldSchema = z.enum(PASS_SETUP_FIELDS);
export type PassSetupField = z.infer<typeof PassSetupFieldSchema>;

export const PassSetupImpactSchema = z.object({
  passesToUpdate: z.number().int().nonnegative().describe('Passes rebuilt and pushed to devices.'),
  channelStops: z
    .array(
      z.object({
        channel: ChannelSchema,
        templates: z.number().int().nonnegative(),
        passes: z.number().int().nonnegative(),
      }),
    )
    .describe('Blocked channels: what stops getting new copies. Copies keep working.'),
  enrolments: z
    .array(WalletProviderSchema)
    .describe('Wallet enrollments the save turns on: Allowed with a ready account.'),
});
export type PassSetupImpact = z.infer<typeof PassSetupImpactSchema>;

/** The PATCH answer, the same for a dry run. */
export const PassSetupResultSchema = z.object({
  dryRun: z.boolean(),
  /** The view after the change (the saved state for an apply, the would-be state for a dry run). */
  view: PassSetupSchema,
  diff: z.array(z.object({ field: PassSetupFieldSchema, before: JsonSchema, after: JsonSchema })),
  impact: PassSetupImpactSchema,
});
export type PassSetupResult = z.infer<typeof PassSetupResultSchema>;

export const BrandAssetSlotSchema = z.enum(['logo', 'icon', 'webLogo']);
const PNG_MAX = Math.ceil((WEB_LOGO.maxBytes * 4) / 3) + 8;

/** POST /api/v1/orgs/{orgId}/brand-assets: stage a PNG for a later save. */
export const StageBrandAssetSchema = z.strictObject({
  slot: BrandAssetSlotSchema,
  png: z.base64().max(PNG_MAX).describe('Base64 PNG; the @3x for a logo or icon.'),
  x2: z
    .base64()
    .max(PNG_MAX)
    .optional()
    .describe('The @2x of a logo or icon; derived when absent.'),
});
export const StagedBrandAssetSchema = z.object({
  slot: BrandAssetSlotSchema,
  sha: ShaSchema,
  version: ShaSchema.describe('Names the stored pair of sizes; send it back with the sha.'),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
  expiresAt: TimestampSchema.describe('Swept after this unless a save names it.'),
});
export type StagedBrandAsset = z.infer<typeof StagedBrandAssetSchema>;
