// PE5a/PE5b: the grants of provider queue and reconcile work. Wallet instance tables join GUARDED_TABLES in PE6, so
// until then the writes are `include` parts tied to {org} and {mode}, and the epoch fences are grant checks.

import { type Grant, jobGrant } from '../../platform/authority.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { AppError, type DenyReason } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { WalletScope } from './instance-types.ts';

/**
 * sync: claim and defer an upsert, active org only. revoke: claim a revoke. record: results, settles and outcomes,
 * whatever the org's state. reconcile: queue an upsert, active org only. retire: stage retirement and queue a revoke.
 * The last three run for a suspended or closed org (design D10).
 */
export type WalletQueuePurpose = 'sync' | 'revoke' | 'record' | 'reconcile' | 'retire';
const ALWAYS: readonly WalletQueuePurpose[] = ['revoke', 'record', 'retire'];

const TABLES: Record<WalletQueuePurpose, readonly string[]> = {
  sync: ['wallet_provider_instance_operations'],
  revoke: ['wallet_provider_instance_operations'],
  record: [
    'wallet_provider_instances',
    'wallet_provider_instance_operations',
    'wallet_provider_instance_outcomes',
    'wallet_provider_sync_targets',
    'wallet_google_revocation_confirmations',
    'wallet_google_messages',
  ],
  reconcile: ['wallet_provider_instances', 'wallet_provider_instance_operations'],
  retire: ['wallet_provider_instances', 'wallet_provider_instance_operations'],
};

const CODES: Record<string, DenyReason> = {
  WALLET_OP_STALE: 'stale',
  WALLET_OP_LINEAGE: 'lineage',
  WALLET_OP_ORG: 'org',
  WALLET_OP_ACTOR: 'actor',
  WALLET_OP_CONFIG: 'config',
  WALLET_OP_RELEASE: 'release',
};

export function walletQueueGrant(
  ctx: ServiceContext,
  purpose: WalletQueuePurpose,
  scope: Pick<WalletScope, 'orgId' | 'mode'>,
  checks: Check[] = [],
): Grant {
  const always = ALWAYS.includes(purpose);
  return jobGrant(ctx, {
    purpose: `org_mode.job.wallet.${purpose}`,
    job: ctx.jobName ?? 'wallet-sync',
    orgId: scope.orgId,
    mode: scope.mode,
    ...(always ? { inactiveOk: true as const, closedOk: true as const } : {}),
    tables: TABLES[purpose],
    checks,
    codes: {
      stale: 'WALLET_OP_STALE',
      lineage: 'WALLET_OP_LINEAGE',
      org: 'WALLET_OP_ORG',
      actor: 'WALLET_OP_ACTOR',
      config: 'WALLET_OP_CONFIG',
      release: 'WALLET_OP_RELEASE',
    },
  });
}

/**
 * Commits the grant. A refusal comes back as its reason (`stale`: the operation or the pass moved; `org`: the org is
 * not active) instead of an error, because the caller turns it into a state, never into a failure.
 */
export async function commitWalletGrant(
  g: Grant,
): Promise<{ results: D1Result[] } | { refused: DenyReason }> {
  try {
    return { results: await g.commit() };
  } catch (error) {
    const reason = error instanceof AppError ? CODES[error.code] : undefined;
    if (reason === undefined) throw error;
    return { refused: reason };
  }
}
