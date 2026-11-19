import type { ResolveWalletMigration } from '@/shared/contracts/wallet-providers.ts';

export type ResolveAction = ResolveWalletMigration['action'];
type Reason = 'identity_shared' | 'org_credential_exists' | 'unreadable' | 'unproven_claim';

/**
 * What the API accepts for a refused account. Unreadable credentials cannot be opened, so only
 * retire works; merge promotes a claimed identity, so it needs a claim; an own credential with
 * the identity is pointed at PassBook's or retired.
 */
export const ACTIONS_BY_REASON: Record<Reason, readonly ResolveAction[]> = {
  identity_shared: ['assign_platform', 'merge', 'retire'],
  unproven_claim: ['assign_platform', 'merge', 'retire'],
  org_credential_exists: ['assign_platform', 'retire'],
  unreadable: ['retire'],
};

export const actionsFor = (reason: Reason | null): readonly ResolveAction[] =>
  reason === null ? ['retire'] : ACTIONS_BY_REASON[reason];
