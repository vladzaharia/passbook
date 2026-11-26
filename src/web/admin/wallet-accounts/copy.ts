import type {
  WalletProvider,
  WalletProviderIssuance,
} from '@/shared/contracts/wallet-providers.ts';
import { ApiError } from '@/web/lib/errors.ts';

export const PROVIDER_NAME: Record<WalletProvider, string> = {
  google: 'Google Wallet',
  samsung: 'Samsung Wallet',
};

export const COPY = {
  readOnly: 'Read-only. Managing wallet accounts needs integrations:manage.',
  noIntegrationAccess: 'Google and Samsung accounts need integrations access.',
  platformSource: 'PassBook',
  ownSource: 'Own account',
  noPlatform: 'PassBook has no account for this mode.',
  noOwn: 'Add your own credentials first.',
  addCredentials: 'Add credentials',
  rotate: 'Rotate',
  revoke: 'Revoke',
  hold: 'Hold',
  release: 'Release',
  reissue: 'Update passes',
  sourceSwitchedOff: 'Source changed. Turned off.',
  empty: 'No organizations enrolled',
} as const;

export const RELEASE = {
  notReleased: (name: string) => `${name} isn't released yet.`,
  testOnly: (name: string) => `${name} is released in Test only.`,
};

type ModeIssuance = Record<'live' | 'test', WalletProviderIssuance>;

/** One mode's line: shown only while the wallet is dark in it. Null when released. */
export function releaseLine(provider: WalletProvider, issuance: WalletProviderIssuance) {
  return issuance.state === 'disabled' ? RELEASE.notReleased(PROVIDER_NAME[provider]) : null;
}

/** The provider's line across both modes: dark in both, or open in Test only. */
export function releaseSummary(provider: WalletProvider, by: ModeIssuance) {
  const name = PROVIDER_NAME[provider];
  const live = by.live.state === 'enabled';
  const test = by.test.state === 'enabled';
  if (!live && !test) return RELEASE.notReleased(name);
  return test && !live ? RELEASE.testOnly(name) : null;
}

/** Why the switch cannot turn on, in the order a person fixes it. */
export const BLOCKER = {
  held: (reason: string) => (reason ? `Held by PassBook: ${reason}` : 'Held by PassBook.'),
  revoked: 'Revoked.',
  source: 'Pick a source first.',
  check: 'The account check has not passed.',
  roundTrip: 'Save a pass from Test mode first.',
} as const;

// Server errors can include request details. Show only fixed, credential-free copy.
export function safeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Your session ended. Sign in and try again.';
    if (error.status === 403) return 'You do not have permission for this.';
    if (error.code === 'WALLET_ENROLMENT_HELD') return 'PassBook is holding this account.';
    if (error.code === 'WALLET_ENROLMENT_PREREQUISITE')
      return 'Not ready yet. Check the status and try again.';
    if (error.code === 'WALLET_CREDENTIAL_IN_USE')
      return 'Other accounts still use these credentials.';
    if (error.code === 'WALLET_IDENTITY_TAKEN')
      return 'Another organization already uses this issuer or partner.';
    if (error.code === 'WALLET_IDENTITY_IMMUTABLE')
      return 'The Google issuer, or Samsung partner and card, cannot change. Enter the original ones.';
    if (error.code === 'WALLET_ACCOUNT_INSTANCES_ACTIVE')
      return 'It still has live wallet passes. Retire them first.';
    if (error.status === 409 || error.status === 412)
      return 'This changed meanwhile. Reload and try again.';
    if (error.status === 400 || error.status === 422)
      return 'The details were rejected. Check them and enter the private key again.';
    if (error.status === 0) return 'Could not connect. Check your connection.';
  }
  return 'Could not complete the request. Try again.';
}

/** Plain words for a check's stable code. */
export const CHECK_WORDS: Record<string, string> = {
  auth_failed: 'The provider refused the credentials.',
  card_not_active: 'The card is not active.',
  card_not_found: 'The card was not found.',
  cert_expired: 'The certificate has expired.',
  cert_expiring: 'The certificate expires within 30 days.',
  credential_unreadable: 'The saved credentials cannot be read. Rotate them.',
  invalid_credentials: 'The credentials are not valid.',
  issuer_mismatch: 'The issuer does not match the credentials.',
  issuer_not_found: 'The issuer was not found.',
  provider_error: 'The provider returned an error. Try again.',
  unreachable: 'Could not reach the provider. Try again.',
};
export const checkWords = (code: string | null) =>
  (code && CHECK_WORDS[code]) || 'The check did not pass.';
export const CHECK_WAIT = 'Wait a minute before checking again.';

export const MIGRATION_REASON: Record<string, string> = {
  identity_shared: 'Shares its provider identity with another organization.',
  org_credential_exists: 'An own credential with this identity already exists.',
  unreadable: 'The saved credentials cannot be read.',
  unproven_claim: 'Claims an identity PassBook cannot prove.',
};
