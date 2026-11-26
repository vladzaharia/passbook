import type { WalletProviderIssuance } from '../../../shared/contracts/wallet-providers.ts';
import { AppError } from '../../platform/errors.ts';
import type { WalletProvider } from './instance-types.ts';
import { RELEASE, type WalletReleaseState } from './release.ts';
import {
  type EnrolmentGateRow,
  findEnrolmentGateRow,
  walletEnrolmentIssuesSql,
  walletEntitled,
} from './repo-enrolment-gate.ts';

export { walletEnrolmentIssuesSql };

/**
 * The only place that decides whether Google or Samsung may issue, update, offer or call out.
 * Account setup and credential storage never consult it. Three layers: the platform release
 * (`not_released`, sync; RELEASE in release.ts), the org's plan (`not_included`) and the org's enrolment in the
 * pass's mode (`not_enrolled`); the last two need the database. No other file may encode "provider X is off".
 */
export type WalletProviderDisabledReason = 'not_released' | 'not_included' | 'not_enrolled';

type Mode = 'live' | 'test';
const MODES: readonly Mode[] = ['live', 'test'];
const PROVIDERS: readonly WalletProvider[] = ['google', 'samsung'];

type Release = Record<WalletProvider, Record<Mode, WalletReleaseState>>;
/** The policy's view of RELEASE: the shipped constant, or a test or e2e override (setWalletReleaseForTest). */
let current: Readonly<Record<WalletProvider, Readonly<Record<Mode, WalletReleaseState>>>> = RELEASE;

const released = (provider: WalletProvider, mode: Mode) => current[provider][mode] === 'released';

/** The release state of a provider in a mode (release.ts). */
export function walletProviderReleaseState(
  provider: WalletProvider,
  mode: Mode,
): WalletReleaseState {
  return current[provider][mode];
}

/**
 * The platform layer alone: for callers with no org. Without a mode, released means released in
 * some mode (an early-out before the mode is known); with one, in that mode. `draining` is not released.
 */
export function walletProviderReleaseReason(
  provider: WalletProvider,
  mode?: Mode,
): Extract<WalletProviderDisabledReason, 'not_released'> | null {
  const open = mode ? released(provider, mode) : MODES.some((m) => released(provider, m));
  return open ? null : 'not_released';
}

/** True when the platform has released the provider (in `mode`, or in any mode); says nothing about any org. */
export function walletProviderEnabled(provider: WalletProvider, mode?: Mode): boolean {
  return walletProviderReleaseReason(provider, mode) === null;
}

/**
 * Whether a revoke (void, removal, transfer, retirement) may reach the provider: released, or draining, so copies
 * already in wallets still go void after a rollback. Without a mode, in some mode.
 */
export function walletProviderRevokes(provider: WalletProvider, mode?: Mode): boolean {
  return (mode ? [mode] : MODES).some((m) => current[provider][m] !== 'dark');
}

/**
 * An enrolment may issue when it is not revoked or held, and is either a legacy envelope row with no
 * enrolment (unchanged) or has an enrolment (a source, migrated or new) that is On. Test counts like Live.
 */
export function walletEnrolmentIssues(row: EnrolmentGateRow | null): boolean {
  return (
    row !== null &&
    row.revoked_at === null &&
    (row.platform_hold_at ?? null) === null &&
    ((row.credential_id !== null && (row.credential_source_id ?? null) === null) ||
      (row.enabled_at ?? null) !== null)
  );
}

/**
 * Null when the provider may run for this org and mode, else the first failing layer. A caller that already
 * read the org's plan passes `entitled` and saves the read.
 */
export async function walletProviderDisabledReason(
  db: D1Database,
  provider: WalletProvider,
  orgId: string,
  mode: Mode,
  entitled?: boolean,
): Promise<WalletProviderDisabledReason | null> {
  const releaseReason = walletProviderReleaseReason(provider, mode);
  if (releaseReason) return releaseReason;
  if (!(entitled ?? (await walletEntitled(db, provider, orgId)))) return 'not_included';
  const row = await findEnrolmentGateRow(db, provider, orgId, mode);
  return walletEnrolmentIssues(row) ? null : 'not_enrolled';
}

/** The issuance state every DTO and page reports for a provider. */
export function walletProviderIssuance(
  provider: WalletProvider,
  mode?: Mode,
): WalletProviderIssuance {
  const reason = walletProviderReleaseReason(provider, mode);
  return reason ? { state: 'disabled', reason } : { state: 'enabled' };
}

export function walletIssuanceByProvider(
  mode?: Mode,
): Record<WalletProvider, WalletProviderIssuance> {
  return {
    google: walletProviderIssuance('google', mode),
    samsung: walletProviderIssuance('samsung', mode),
  };
}

export class WalletProviderDisabledError extends AppError {
  readonly reason: WalletProviderDisabledReason;

  constructor(provider: WalletProvider, reason: WalletProviderDisabledReason) {
    super('WALLET_PROVIDER_DISABLED', 403, `${provider} wallet is not available yet.`);
    this.reason = reason;
  }
}

export function assertWalletProviderEnabled(provider: WalletProvider, mode?: Mode): void {
  const reason = walletProviderReleaseReason(provider, mode);
  if (reason) throw new WalletProviderDisabledError(provider, reason);
}

/** For a revoke's provider call: released or draining (walletProviderRevokes). */
export function assertWalletProviderRevokes(provider: WalletProvider, mode: Mode): void {
  if (!walletProviderRevokes(provider, mode))
    throw new WalletProviderDisabledError(provider, 'not_released');
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/**
 * Trusted SQL predicate over a provider column (and a mode column, when the row has one); the only
 * SQL form of the release gate. Without a mode column it opens when any mode is released.
 */
export function walletProviderEnabledSql(providerSql: string, modeSql?: string): string {
  if (!IDENT.test(providerSql) || (modeSql !== undefined && !IDENT.test(modeSql)))
    throw new Error('Invalid trusted wallet provider identifier');
  const open = PROVIDERS.map((p) => ({ p, modes: MODES.filter((m) => released(p, m)) })).filter(
    (e) => e.modes.length > 0,
  );
  if (open.length === 0) return '1 = 0';
  if (modeSql === undefined || open.every((e) => e.modes.length === MODES.length))
    return `${providerSql} IN (${open.map((e) => `'${e.p}'`).join(', ')})`;
  return `(${open
    .map(
      (e) =>
        `(${providerSql} = '${e.p}' AND ${modeSql} IN (${e.modes.map((m) => `'${m}'`).join(', ')}))`,
    )
    .join(' OR ')})`;
}

/**
 * Tests only: overrides the code side of the release (RELEASE) for the current test file's module registry, for one
 * provider and mode or all of them; returns a restorer. The database side is the `wallet_provider_releases` row.
 */
export function setWalletReleaseForTest(
  state: WalletReleaseState,
  scope: { provider?: WalletProvider; mode?: Mode } = {},
): () => void {
  const previous = current;
  const next: Release = structuredClone(current) as Release;
  for (const p of PROVIDERS)
    for (const m of MODES)
      if ((!scope.provider || p === scope.provider) && (!scope.mode || m === scope.mode))
        next[p][m] = state;
  current = next;
  return () => {
    current = previous;
  };
}

/** Tests only: releases (or darkens) every provider, in `mode` or both; returns a restorer. */
export function setWalletProvidersEnabledForTest(enabled: boolean, mode?: Mode): () => void {
  return setWalletReleaseForTest(enabled ? 'released' : 'dark', mode ? { mode } : {});
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
