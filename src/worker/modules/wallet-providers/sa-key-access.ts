import type { GoogleWalletCredentials } from '../../../shared/contracts/wallet-providers.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { emailPlatformAdmins } from '../identities/alerts.ts';
import { validateGoogleAccount } from './google-credentials.ts';
import { IAM_SCOPE } from './google-iam.ts';
import { managedDeps } from './google-managed-deps.ts';
import { getGoogleAccessToken } from './google-oauth.ts';

/** An IAM-scope token of the service account in `credentials` (never cached). */
export async function iamToken(
  ctx: ServiceContext,
  credentials: GoogleWalletCredentials,
): Promise<string> {
  const { accessToken } = await getGoogleAccessToken(await validateGoogleAccount(credentials), {
    issuedAt: Math.floor(ctx.clock.now() / 1000),
    fetcher: managedDeps().fetcher(),
    scope: IAM_SCOPE,
  });
  return accessToken;
}

/** The key alert: error log with a stable code, then an email to the platform admins (best effort). */
export async function keyAlert(
  ctx: ServiceContext,
  code: string,
  subject: string,
  text: string,
): Promise<void> {
  ctx.log.error('wallet.key_alert', { code });
  await emailPlatformAdmins(ctx, subject, text);
}
