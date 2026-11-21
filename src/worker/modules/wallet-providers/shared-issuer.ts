import type { WalletCredential } from '../../../shared/contracts/wallet-providers.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import {
  ConflictError,
  ForbiddenError,
  UpstreamError,
  ValidationError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { credentialIdentityHash } from './account-credential-source.ts';
import { credentialDto, orgWriter, save } from './credential-service.ts';
import { readGoogleSecret } from './credential-system-save.ts';
import { isGoogleIssuerId } from './google-credentials.ts';
import { GoogleWalletError } from './google-errors.ts';
import { getGoogleIssuer } from './google-issuer-rest.ts';
import { managedDeps } from './google-managed-deps.ts';
import { platformAccess } from './google-platform-access.ts';
import {
  activeOrgGoogle,
  activePlatformGoogle,
  issuerClaimedElsewhere,
} from './repo-google-managed.ts';

function sessionOf(auth: SessionAuth): SessionAuth {
  if (auth?.kind !== 'session') throw new ForbiddenError();
  return auth;
}

/** PassBook's service-account address for the session's mode: what the org adds to its issuer. */
export async function sharedIssuerInfo(
  ctx: ServiceContext,
  auth: SessionAuth,
  orgId: string,
): Promise<{ serviceAccountEmail: string | null }> {
  await tenantAuthorityOf(ctx, sessionOf(auth), orgId, 'integrations:read');
  const platform = await activePlatformGoogle(ctx.env.DB, auth.mode);
  if (!platform) return { serviceAccountEmail: null };
  return {
    serviceAccountEmail: (await readGoogleSecret(ctx, platform.id)).credentials.serviceAccountEmail,
  };
}

/**
 * Own issuer, shared with PassBook's service account: `issuer.get` proves the access, and the org's
 * credential then holds PassBook's key (no key changes hands). It follows the platform key's rotation.
 */
export async function shareGoogleIssuer(
  ctx: ServiceContext,
  auth: SessionAuth,
  orgId: string,
  issuerId: string,
): Promise<{ credential: WalletCredential; serviceAccountEmail: string }> {
  const mode = sessionOf(auth).mode;
  const w = await orgWriter(ctx, auth, orgId, 'org_mode.wallet.credential_save');
  if (!isGoogleIssuerId(issuerId))
    throw new ValidationError('Invalid issuer id.', [], 'WALLET_CREDENTIALS_INVALID');
  const access = await platformAccess(ctx, mode);
  const email = access.credentials.serviceAccountEmail;
  try {
    await getGoogleIssuer(
      { accessToken: access.accessToken, fetcher: managedDeps().fetcher() },
      issuerId,
    );
  } catch (error) {
    if (!(error instanceof GoogleWalletError)) throw error;
    if (error.code === 'forbidden' || error.code === 'not_found')
      throw new ValidationError(
        `Add ${email} as a user of this issuer in the Google Pay & Wallet Console, then try again.`,
        [],
        'GOOGLE_ISSUER_NOT_SHARED',
      );
    throw new UpstreamError('Google did not answer. Try again.', 'GOOGLE_UNAVAILABLE');
  }
  const secret = { ...access.credentials, issuerId };
  const hash = await credentialIdentityHash({ provider: 'google', credentials: secret });
  if (await issuerClaimedElsewhere(ctx.env.DB, hash, mode, orgId))
    throw new ConflictError('Another organization uses this issuer.', 'WALLET_ISSUER_CLAIMED');
  const current = await activeOrgGoogle(ctx.env.DB, orgId, mode);
  if (current) {
    if (current.signer_ref !== access.credential.id || current.identity_hash !== hash)
      throw new ConflictError(
        'This organization already has a Google issuer.',
        'WALLET_ISSUER_EXISTS',
      );
    return { credential: credentialDto(current), serviceAccountEmail: email };
  }
  const row = await save(
    ctx,
    w,
    { orgId, mode },
    { provider: 'google', expectedRevision: 0, credentials: secret },
    { provenance: 'own', signerRef: access.credential.id },
  );
  return { credential: credentialDto(row), serviceAccountEmail: email };
}
