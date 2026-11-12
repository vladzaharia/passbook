import { z } from 'zod';
import { WalletProviderIssuanceSchema, WalletProviderSchema } from './wallet-providers.ts';

/** Local instance lifecycle, not evidence that a pass is installed or eligible to offer. */
export const WalletProviderInstanceLifecycleSchema = z.enum([
  'absent',
  'blocked',
  'ready',
  'active',
  'revoking',
  'revoked',
  'retired',
]);

/** Only the current desired operation's closed, non-sensitive outcome is returned. */
export const WalletProviderDesiredOperationSchema = z.strictObject({
  version: z.number().int().positive(),
  kind: z.enum(['upsert', 'revoke']),
  state: z.enum(['pending', 'claimed', 'retry', 'succeeded', 'failed', 'superseded', 'uncertain']),
  reason: z
    .enum([
      'ok',
      'not_issued',
      'rate_limited',
      'unavailable',
      'timeout',
      'unauthorized',
      'rejected',
      'invalid_response',
      'provider_error',
    ])
    .nullable(),
});

export const WalletProviderInstanceStatusSchema = z.strictObject({
  provider: WalletProviderSchema,
  /** Absent means no instance for this generation, not that the provider is unconfigured. */
  lifecycle: WalletProviderInstanceLifecycleSchema,
  desiredOperation: WalletProviderDesiredOperationSchema.nullable(),
  priorGenerationRetirementPending: z.boolean(),
  /** Neither a provider operation nor a retirement proves device installation or deletion. */
  installation: z.literal('unknown'),
  issuance: WalletProviderIssuanceSchema,
});
export type WalletProviderInstanceStatus = z.infer<typeof WalletProviderInstanceStatusSchema>;

export const WalletProviderPassStatusSchema = z.strictObject({
  credentialGeneration: z.number().int().positive(),
  providers: z.tuple([
    WalletProviderInstanceStatusSchema.extend({ provider: z.literal('google') }),
    WalletProviderInstanceStatusSchema.extend({ provider: z.literal('samsung') }),
  ]),
});
export type WalletProviderPassStatus = z.infer<typeof WalletProviderPassStatusSchema>;
