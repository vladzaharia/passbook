import type { WalletProviderIssuance } from '../../../shared/contracts/wallet-providers.ts';
import { AppError } from '../../platform/errors.ts';
import type { WalletProvider } from './instance-types.ts';
import {
  type EnrolmentGateRow,
  findEnrolmentGateRow,
  walletEnrolmentIssuesSql,
} from './repo-enrolment-gate.ts';

export { walletEnrolmentIssuesSql };

/**
 * The only place that decides whether Google or Samsung may issue, update, offer or call out.
 * Account setup and credential storage never consult it. Two layers: the platform release
 * (`not_released`, sync) and the org's enrolment in the pass's mode (`not_enrolled`, needs the
 * database). Enabling a provider is a release decision made here; no other file may encode
 * "provider X is off".
 */
export type WalletProviderDisabledReason = 'not_released' | 'not_enrolled';

const ENABLED: Record<WalletProvider, boolean> = { google: false, samsung: false };

/** The platform layer alone: for callers with no org (callbacks, platform status, drains). */
export function walletProviderReleaseReason(
  provider: WalletProvider,
): Extract<WalletProviderDisabledReason, 'not_released'> | null {
  return ENABLED[provider] ? null : 'not_released';
}

/** True when the platform has released the provider; says nothing about any org. */
export function walletProviderEnabled(provider: WalletProvider): boolean {
  return walletProviderReleaseReason(provider) === null;
}

/**
 * An enrolment may issue when it is not revoked or held, and is either a legacy envelope row
 * (unchanged) or a new-model row that is On. Test counts like Live.
 */
export function walletEnrolmentIssues(row: EnrolmentGateRow | null): boolean {
  return (
    row !== null &&
    row.revoked_at === null &&
    (row.platform_hold_at ?? null) === null &&
    (row.credential_id !== null || (row.enabled_at ?? null) !== null)
  );
}

/** Null when the provider may run for this org and mode, else the first failing layer. */
export async function walletProviderDisabledReason(
  db: D1Database,
  provider: WalletProvider,
  orgId: string,
  mode: 'live' | 'test',
): Promise<WalletProviderDisabledReason | null> {
  const released = walletProviderReleaseReason(provider);
  if (released) return released;
  const row = await findEnrolmentGateRow(db, provider, orgId, mode);
  return walletEnrolmentIssues(row) ? null : 'not_enrolled';
}

/** The issuance state every DTO and page reports for a provider. */
export function walletProviderIssuance(provider: WalletProvider): WalletProviderIssuance {
  const reason = walletProviderReleaseReason(provider);
  return reason ? { state: 'disabled', reason } : { state: 'enabled' };
}

export function walletIssuanceByProvider(): Record<WalletProvider, WalletProviderIssuance> {
  return { google: walletProviderIssuance('google'), samsung: walletProviderIssuance('samsung') };
}

export class WalletProviderDisabledError extends AppError {
  readonly reason: WalletProviderDisabledReason;

  constructor(provider: WalletProvider, reason: WalletProviderDisabledReason) {
    super('WALLET_PROVIDER_DISABLED', 403, `${provider} wallet is not available yet.`);
    this.reason = reason;
  }
}

export function assertWalletProviderEnabled(provider: WalletProvider): void {
  const reason = walletProviderReleaseReason(provider);
  if (reason) throw new WalletProviderDisabledError(provider, reason);
}

/** Trusted SQL predicate over a provider column; the only SQL form of the gate. */
export function walletProviderEnabledSql(providerSql: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(providerSql))
    throw new Error('Invalid trusted wallet provider identifier');
  const enabled = (['google', 'samsung'] as const).filter(walletProviderEnabled);
  return enabled.length
    ? `${providerSql} IN (${enabled.map((p) => `'${p}'`).join(', ')})`
    : '1 = 0';
}

/** Tests only: flips the gate for the current test file's module registry; returns a restorer. */
export function setWalletProvidersEnabledForTest(enabled: boolean): () => void {
  const previous = { ...ENABLED };
  ENABLED.google = enabled;
  ENABLED.samsung = enabled;
  return () => Object.assign(ENABLED, previous);
}

/** Tests only: runs a call that must be denied while providers are disabled. */
export async function whileDisabledForTest<A extends unknown[], R>(
  call: (...args: A) => Promise<R>,
  ...args: A
): Promise<R> {
  const restore = setWalletProvidersEnabledForTest(false);
  try {
    return await call(...args);
  } finally {
    restore();
  }
}
