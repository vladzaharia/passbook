import type { GoogleWalletCredentials } from '../../../shared/contracts/wallet-providers.ts';
import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { readGoogleSecret } from './credential-system-save.ts';
import { validateGoogleAccount } from './google-credentials.ts';
import { managedDeps } from './google-managed-deps.ts';
import { getGoogleAccessToken } from './google-oauth.ts';
import type { CredentialRow } from './repo-credentials.ts';
import { activePlatformGoogle } from './repo-google-managed.ts';

export interface PlatformAccess {
  credential: CredentialRow;
  credentials: GoogleWalletCredentials;
  /** A Wallet-scope token of PassBook's service account. */
  accessToken: string;
}

const missing = () =>
  new ConflictError(
    "PassBook's Google credential is not set up.",
    'WALLET_PLATFORM_CREDENTIAL_MISSING',
  );

/** PassBook's own Google service account for a mode: its credential, secret and a fresh token. */
export async function platformAccess(
  ctx: ServiceContext,
  mode: 'live' | 'test',
): Promise<PlatformAccess> {
  const credential = await activePlatformGoogle(ctx.env.DB, mode);
  if (!credential) throw missing();
  const { credentials } = await readGoogleSecret(ctx, credential.id);
  const { accessToken } = await getGoogleAccessToken(await validateGoogleAccount(credentials), {
    issuedAt: Math.floor(ctx.clock.now() / 1000),
    fetcher: managedDeps().fetcher(),
  });
  return { credential, credentials, accessToken };
}
