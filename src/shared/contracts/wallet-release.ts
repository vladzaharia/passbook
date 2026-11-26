import { z } from 'zod';
import { WalletCredentialListSchema, WalletProviderIssuanceSchema } from './wallet-providers.ts';

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
