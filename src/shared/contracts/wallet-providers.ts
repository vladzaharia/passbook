import { z } from 'zod';
import { IdSchema, ModeSchema, pageOf, TimestampSchema } from './common.ts';
import { WalletCredentialLastCheckSchema } from './wallet-credential-check.ts';

export const WalletProviderSchema = z.enum(['google', 'samsung']);
export type WalletProvider = z.infer<typeof WalletProviderSchema>;

/** Every account and every approval is isolated by organization, mode and provider. */
export const WalletProviderScopeSchema = z.strictObject({
  orgId: IdSchema,
  mode: ModeSchema,
  provider: WalletProviderSchema,
});
export type WalletProviderScope = z.infer<typeof WalletProviderScopeSchema>;

const pem = z.string().min(1).max(32768);
const providerId = z.string().min(1).max(255);

/** These request-only credentials are never returned by the administration API. */
export const GoogleWalletCredentialsSchema = z.strictObject({
  issuerId: providerId,
  serviceAccountEmail: z.string().min(1).max(254),
  privateKeyPem: pem,
  scopes: z.array(z.literal('https://www.googleapis.com/auth/wallet_object.issuer')).length(1),
});
export type GoogleWalletCredentials = z.infer<typeof GoogleWalletCredentialsSchema>;

/** Card types a Samsung projection supports; the form offers a card row for each. */
export const SAMSUNG_CARD_TYPES = ['loyalty', 'ticket', 'coupon'] as const;

/** Samsung card type (`loyalty`, `ticket`, ...) as the provider names it. */
export const SamsungCardTypeSchema = z.string().regex(/^[a-z]{1,16}$/);

export const SamsungWalletCredentialsSchema = z.strictObject({
  partnerId: providerId,
  certificateId: providerId,
  /** The default card, used by every type without its own entry in `cardIds`. */
  cardId: providerId,
  /** Samsung cards per pass type; a type's pass never uses another type's card. */
  cardIds: z
    .record(SamsungCardTypeSchema, providerId)
    .refine((map) => Object.keys(map).length <= 8)
    // `generic` names the default card (`cardId`) in the card map.
    .refine((map) => !Object.hasOwn(map, 'generic'))
    .optional(),
  partnerPrivateKeyPem: pem,
  partnerCertificatePem: pem,
  samsungCertificatePem: pem,
});
export type SamsungWalletCredentials = z.infer<typeof SamsungWalletCredentialsSchema>;

const revision = z.number().int().nonnegative();
export const ConfigureWalletProviderAccountSchema = z.discriminatedUnion('provider', [
  z.strictObject({
    orgId: IdSchema,
    mode: ModeSchema,
    provider: z.literal('google'),
    expectedRevision: revision,
    credentials: GoogleWalletCredentialsSchema,
  }),
  z.strictObject({
    orgId: IdSchema,
    mode: ModeSchema,
    provider: z.literal('samsung'),
    expectedRevision: revision,
    credentials: SamsungWalletCredentialsSchema,
  }),
]);
export type ConfigureWalletProviderAccount = z.infer<typeof ConfigureWalletProviderAccountSchema>;

export const RevokeWalletProviderAccountSchema = WalletProviderScopeSchema.extend({
  expectedRevision: revision,
});
export type RevokeWalletProviderAccount = z.infer<typeof RevokeWalletProviderAccountSchema>;

/** Release gate: the provider may be configured but not yet issue, update or offer. */
export const WalletProviderIssuanceSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('disabled'), reason: z.literal('not_released') }),
  z.strictObject({ state: z.literal('enabled') }),
]);
export type WalletProviderIssuance = z.infer<typeof WalletProviderIssuanceSchema>;

export const WalletProviderReadinessSchema = z.strictObject({
  orgId: IdSchema,
  mode: ModeSchema,
  provider: WalletProviderSchema,
  accountId: IdSchema.nullable(),
  revision,
  state: z.enum(['absent', 'configured', 'revoked']),
  // No provider approval proof has been verified by the current account implementation.
  externalApprovalVerified: z.literal(false),
  issuance: WalletProviderIssuanceSchema,
  updatedAt: TimestampSchema.nullable(),
});
export type WalletProviderReadiness = z.infer<typeof WalletProviderReadinessSchema>;

const saveMember = <P extends 'google' | 'samsung', C extends z.ZodType>(
  provider: P,
  credentials: C,
) => z.strictObject({ provider: z.literal(provider), expectedRevision: revision, credentials });

/** Create or rotate the credential of the session mode. Secrets are request-only. */
export const SaveWalletCredentialSchema = z.discriminatedUnion('provider', [
  saveMember('google', GoogleWalletCredentialsSchema),
  saveMember('samsung', SamsungWalletCredentialsSchema),
]);
export type SaveWalletCredential = z.infer<typeof SaveWalletCredentialSchema>;

/** A platform admin names the mode: the platform pages show Live and Test together. */
export const SavePlatformWalletCredentialSchema = z.discriminatedUnion('provider', [
  saveMember('google', GoogleWalletCredentialsSchema).extend({ mode: ModeSchema }),
  saveMember('samsung', SamsungWalletCredentialsSchema).extend({ mode: ModeSchema }),
]);
export type SavePlatformWalletCredential = z.infer<typeof SavePlatformWalletCredentialSchema>;

export const RevokeWalletCredentialSchema = z.strictObject({ expectedRevision: revision });
export type RevokeWalletCredential = z.infer<typeof RevokeWalletCredentialSchema>;

/** What a credential shows: identity hint only (the last 4 characters), never a secret. */
export const WalletCredentialSchema = z.strictObject({
  id: IdSchema,
  scope: z.enum(['platform', 'org']),
  orgId: IdSchema.nullable(),
  mode: ModeSchema,
  provider: WalletProviderSchema,
  identityHint: z.string(),
  /** platform: PassBook's own; managed: a child issuer PassBook made; own: the org's issuer. */
  provenance: z.enum(['platform', 'managed', 'own']),
  revision,
  verifiedAt: TimestampSchema.nullable(),
  revokedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  /** Samsung: the card types that have a card (the default card serves loyalty). Empty for Google. */
  cardTypes: z.array(SamsungCardTypeSchema),
  lastCheck: WalletCredentialLastCheckSchema.nullable(),
});
export type WalletCredential = z.infer<typeof WalletCredentialSchema>;

export const WalletCredentialListSchema = pageOf(WalletCredentialSchema);
export type WalletCredentialList = z.infer<typeof WalletCredentialListSchema>;

const ReleaseByModeSchema = z.strictObject({
  live: WalletProviderIssuanceSchema,
  test: WalletProviderIssuanceSchema,
});
/** Release state per provider and mode: the platform pages say it where credentials are set. */
export const WalletReleaseSchema = z.strictObject({
  google: ReleaseByModeSchema,
  samsung: ReleaseByModeSchema,
});
export type WalletRelease = z.infer<typeof WalletReleaseSchema>;

export const PlatformWalletCredentialListSchema = WalletCredentialListSchema.extend({
  release: WalletReleaseSchema,
});
export type PlatformWalletCredentialList = z.infer<typeof PlatformWalletCredentialListSchema>;

export const WalletCredentialParamsSchema = z.strictObject({ orgId: IdSchema, id: IdSchema });
export const WalletEnrolmentParamsSchema = z.strictObject({
  orgId: IdSchema,
  provider: WalletProviderSchema,
});
export const PlatformWalletEnrolmentParamsSchema = z.strictObject({
  orgId: IdSchema,
  mode: ModeSchema,
  provider: WalletProviderSchema,
});

export const WalletEnrolmentSourceSchema = z.enum(['platform', 'org']);

/** `held` is the platform's hold; `off` and `on` are the org's own switch. */
export const WalletEnrolmentSchema = z.strictObject({
  mode: ModeSchema,
  provider: WalletProviderSchema,
  accountId: IdSchema.nullable(),
  source: WalletEnrolmentSourceSchema.nullable(),
  platformAvailable: z.boolean(),
  state: z.enum(['absent', 'off', 'on', 'held', 'revoked']),
  enrolmentRevision: revision,
  prerequisites: z.strictObject({
    check: z.boolean(),
    /** Null in Test mode, which needs no round trip. */
    roundTrip: z.boolean().nullable(),
  }),
  hold: z.strictObject({ at: TimestampSchema, reason: z.string() }).nullable(),
  issuance: WalletProviderIssuanceSchema,
});
export type WalletEnrolment = z.infer<typeof WalletEnrolmentSchema>;

export const WalletEnrolmentListSchema = pageOf(WalletEnrolmentSchema);
export type WalletEnrolmentList = z.infer<typeof WalletEnrolmentListSchema>;

export const SetWalletEnrolmentSourceSchema = z.strictObject({
  source: WalletEnrolmentSourceSchema,
  expectedRevision: revision,
});
export type SetWalletEnrolmentSource = z.infer<typeof SetWalletEnrolmentSourceSchema>;

/** Enable, disable and revoke act on the enrolment revision the caller read. */
export const WalletEnrolmentActionSchema = z.strictObject({ expectedRevision: revision });
export type WalletEnrolmentAction = z.infer<typeof WalletEnrolmentActionSchema>;

export const HoldWalletEnrolmentSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500),
});
export type HoldWalletEnrolment = z.infer<typeof HoldWalletEnrolmentSchema>;

export const WalletEnrolmentHoldResultSchema = z.strictObject({
  // `queued` when the org is suspended: a job writes the hold.
  status: z.enum(['held', 'released', 'queued']),
});

/** A platform admin sees every org's enrolment of a provider, Live and Test together. */
export const PlatformWalletEnrolmentSchema = z.strictObject({
  orgId: IdSchema,
  orgName: z.string(),
  mode: ModeSchema,
  provider: WalletProviderSchema,
  source: WalletEnrolmentSourceSchema.nullable(),
  state: z.enum(['off', 'on', 'held', 'revoked']),
  hold: z.strictObject({ at: TimestampSchema, reason: z.string() }).nullable(),
  updatedAt: TimestampSchema,
});
export type PlatformWalletEnrolment = z.infer<typeof PlatformWalletEnrolmentSchema>;

export const PlatformWalletEnrolmentListSchema = z.strictObject({
  items: z.array(PlatformWalletEnrolmentSchema),
  nextCursor: z.string().nullable(),
});
export const PlatformWalletEnrolmentQuerySchema = z.strictObject({
  provider: WalletProviderSchema,
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type PlatformWalletEnrolmentList = z.infer<typeof PlatformWalletEnrolmentListSchema>;
/** An account on the legacy envelope waiting for a source. Provider ids never appear; `identityShared` names the others. */
export const WalletMigrationItemSchema = z.strictObject({
  accountId: IdSchema,
  orgId: IdSchema,
  mode: ModeSchema,
  provider: WalletProviderSchema,
  state: z.enum(['ready', 'refused']),
  reason: z
    .enum(['identity_shared', 'org_credential_exists', 'unreadable', 'unproven_claim'])
    .nullable(),
  identityShared: z.array(WalletProviderScopeSchema),
});

export const WalletMigrationReportSchema = z.strictObject({
  /** Accounts with no source yet and not retired; the gate clears at 0. */
  pending: z.number().int().nonnegative(),
  migrated: z.number().int().nonnegative(),
  items: z.array(WalletMigrationItemSchema),
  nextCursor: IdSchema.nullable(),
  /** Pass as `after` for the next page; null on the last. */
  next: IdSchema.nullable(),
});

export const WalletMigrationReportQuerySchema = z.strictObject({
  /** Deprecated: use `cursor`. */
  after: IdSchema.optional(),
  cursor: IdSchema.optional(),
});
export type WalletMigrationReport = z.infer<typeof WalletMigrationReportSchema>;

export const WalletMigrationQueuedSchema = z.strictObject({
  queued: z.number().int().nonnegative(),
});

export const ResolveWalletMigrationSchema = WalletProviderScopeSchema.extend({
  action: z.enum(['assign_platform', 'merge', 'retire']),
});
export type ResolveWalletMigration = z.infer<typeof ResolveWalletMigrationSchema>;

export const WalletMigrationResolvedSchema = z.strictObject({
  /** Accounts the action moved: one, or every colliding account for a merge. */
  accounts: z.number().int().nonnegative(),
});

/** A check runs as a job: the request returns the id its result is read under. */
export const WalletCredentialCheckQueuedSchema = z.strictObject({
  checkId: IdSchema,
  status: z.literal('queued'),
});
export type WalletCredentialCheckQueued = z.infer<typeof WalletCredentialCheckQueuedSchema>;

export const WalletCredentialCheckResultSchema = z.strictObject({
  checkId: IdSchema,
  status: z.enum(['pending', 'ok', 'failed']),
  code: z.string().nullable(),
  checkedAt: TimestampSchema.nullable(),
});
export type WalletCredentialCheckResult = z.infer<typeof WalletCredentialCheckResultSchema>;

export const WalletCredentialCheckParamsSchema = WalletCredentialParamsSchema.extend({
  checkId: IdSchema,
});
export const PlatformWalletCredentialCheckParamsSchema = z.strictObject({
  id: IdSchema,
  checkId: IdSchema,
});

/** Google managed issuer: a child issuer PassBook makes for the org ("<Org> via PassBook"). */
export const GoogleManagedIssuerRequestSchema = z.strictObject({ mode: z.literal('live') });

export const GoogleManagedOrgParamsSchema = z.strictObject({ orgId: IdSchema });

/** The run that makes the issuer. `waiting: google_manual_issuer` until a platform admin enters an issuer id. */
export const GoogleIssuerRunSchema = z.strictObject({
  runId: IdSchema,
  state: z.enum(['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled']),
  step: z.string().nullable(),
  waitingFor: z.string().nullable(),
  errorCode: z.string().nullable(),
  issuerId: z.string().nullable(),
  updatedAt: TimestampSchema,
});
export type GoogleIssuerRun = z.infer<typeof GoogleIssuerRunSchema>;

/** The org's latest managed-issuer run, or null before the first. */
export const GoogleManagedStatusSchema = z.strictObject({ run: GoogleIssuerRunSchema.nullable() });

/** A platform admin finishes a parked run with an issuer made in the Google Pay & Wallet Console. */
export const CompleteGoogleManagedIssuerSchema = z.strictObject({
  issuerId: z.string().regex(/^[0-9]{1,32}$/),
});

/** Own issuer shared with PassBook's service account: no key changes hands. */
export const ShareGoogleIssuerSchema = z.strictObject({
  issuerId: z.string().regex(/^[0-9]{1,32}$/),
});

export const GoogleSharedIssuerInfoSchema = z.strictObject({
  /** The address the org adds as a user of its issuer in the Google Pay & Wallet Console. */
  serviceAccountEmail: z.string().nullable(),
});

export const GoogleSharedIssuerSchema = z.strictObject({
  credential: WalletCredentialSchema,
  serviceAccountEmail: z.string(),
});

/** Starts a service-account key rotation of a platform credential now. */
export const WalletCredentialKeyRotationSchema = z.strictObject({ runId: IdSchema });
export const WalletCredentialIdParamsSchema = z.strictObject({ id: IdSchema });
