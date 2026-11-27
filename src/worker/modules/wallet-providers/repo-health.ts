import type { WalletProvider } from '../../../shared/contracts/wallet-providers.ts';
import { all } from '../../platform/db.ts';
import { UNCERTAIN_GRACE_MS } from './repo-sync-uncertain.ts';

export interface WalletHealthRow {
  provider: WalletProvider;
  lastSuccessAt: number | null;
  queued: number;
  failed24h: number;
  uncertain: number;
  uncertainWaiting: number;
  callbackAt: number | null;
}

const DAY_MS = 86_400_000;

/** Current operations only (the instance's desired one), so the counts stay bounded by the org's instances. */
export function readWalletHealthRows(
  db: D1Database,
  orgId: string,
  mode: 'live' | 'test',
  now: number,
): Promise<WalletHealthRow[]> {
  return all<WalletHealthRow>(
    db,
    `SELECT i.provider AS provider,
      MAX(CASE WHEN cur.state = 'succeeded' THEN cur.completed_at END) AS lastSuccessAt,
      COALESCE(SUM(cur.state IN ('pending', 'claimed', 'retry')), 0) AS queued,
      COALESCE(SUM(cur.state = 'failed' AND cur.last_result_at >= ?), 0) AS failed24h,
      COALESCE(SUM(EXISTS (SELECT 1 FROM wallet_provider_instance_operations u
        WHERE u.instance_id = i.id AND u.state = 'uncertain')), 0) AS uncertain,
      COALESCE(SUM(EXISTS (SELECT 1 FROM wallet_provider_instance_operations u
        WHERE u.instance_id = i.id AND u.state = 'uncertain' AND u.last_attempt_at > ?)), 0) AS uncertainWaiting,
      NULLIF(MAX(MAX(COALESCE(i.saved_at, 0), COALESCE(i.holder_removed_at, 0))), 0) AS callbackAt
    FROM wallet_provider_instances i
    LEFT JOIN wallet_provider_instance_operations cur ON cur.id = i.desired_operation_id
    WHERE i.org_id = ? AND i.mode = ?
    GROUP BY i.provider`,
    [now - DAY_MS, now - UNCERTAIN_GRACE_MS, orgId, mode],
  );
}
