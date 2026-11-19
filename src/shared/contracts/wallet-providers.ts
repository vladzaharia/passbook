import { z } from 'zod';
import { IdSchema, ModeSchema, TimestampSchema } from './common.ts';

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

export const SamsungWalletCredentialsSchema = z.strictObject({
  partnerId: providerId,
  certificateId: providerId,
  cardId: providerId,
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
  revision,
  verifiedAt: TimestampSchema.nullable(),
  revokedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type WalletCredential = z.infer<typeof WalletCredentialSchema>;

export const WalletCredentialListSchema = z.strictObject({
  items: z.array(WalletCredentialSchema),
});
export type WalletCredentialList = z.infer<typeof WalletCredentialListSchema>;

export const WalletCredentialListQuerySchema = z.strictObject({
  provider: WalletProviderSchema.optional(),
});

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

export const WalletEnrolmentListSchema = z.strictObject({ items: z.array(WalletEnrolmentSchema) });
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
  /** Pass as `after` for the next page; null on the last. */
  next: IdSchema.nullable(),
});

export const WalletMigrationReportQuerySchema = z.strictObject({ after: IdSchema.optional() });
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
