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
