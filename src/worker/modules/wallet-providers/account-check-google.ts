import type { GoogleWalletCredentials } from '../../../shared/contracts/wallet-providers.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { CheckOutcome } from './account-check-types.ts';
import { validateGoogleAccount } from './google-credentials.ts';
import { GoogleWalletError, googleFetch } from './google-errors.ts';
import { getGoogleAccessToken } from './google-oauth.ts';
import { providerFetch } from './mock-endpoint.ts';

const ISSUER_API = 'https://walletobjects.googleapis.com/walletobjects/v1/issuer';

function codeOf(error: unknown): string {
  if (!(error instanceof GoogleWalletError)) return 'invalid_credentials';
  switch (error.code) {
    case 'invalid_credentials':
    case 'invalid_input':
      return 'invalid_credentials';
    case 'bad_request':
    case 'unauthorized':
      return 'auth_failed';
    case 'forbidden':
    case 'not_found':
      return 'issuer_not_found';
    case 'network':
    case 'timeout':
    case 'rate_limited':
    case 'server_error':
      return 'unreachable';
    default:
      return 'provider_error';
  }
}

/**
 * Mints an OAuth token with the service account, then reads the issuer. A token proves the key; the issuer
 * read proves the account may act for this issuer id.
 */
export async function probeGoogleIssuer(
  ctx: ServiceContext,
  credentials: GoogleWalletCredentials,
): Promise<CheckOutcome> {
  try {
    const account = await validateGoogleAccount(credentials);
    const fetcher = providerFetch(ctx.env);
    const { accessToken } = await getGoogleAccessToken(account, {
      issuedAt: Math.floor(ctx.clock.now() / 1000),
      fetcher,
    });
    const response = await googleFetch(
      fetcher,
      `${ISSUER_API}/${encodeURIComponent(account.issuerId)}`,
      { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } },
      'issuer',
    );
    if (response.status === 401) return { ok: false, code: 'auth_failed' };
    if (response.status === 403 || response.status === 404)
      return { ok: false, code: 'issuer_not_found' };
    if (response.status === 429 || response.status >= 500)
      return { ok: false, code: 'unreachable' };
    if (!response.ok) return { ok: false, code: 'provider_error' };
    const body: unknown = await response.json().catch(() => null);
    const issuerId = (body as { issuerId?: unknown } | null)?.issuerId;
    return String(issuerId) === account.issuerId
      ? { ok: true, code: null }
      : { ok: false, code: 'issuer_mismatch' };
  } catch (error) {
    return { ok: false, code: codeOf(error) };
  }
}
