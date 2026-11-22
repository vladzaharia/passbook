import { all, first } from '../../platform/db.ts';
import type { WalletMode, WalletProvider } from './instance-types.ts';

export interface ReissueScope {
  orgId: string;
  mode: WalletMode;
  provider: WalletProvider;
  templateId?: string | undefined;
}

/**
 * The provider copies a reissue reaches: active, not retiring, past the placeholder stage (Q4: objects are
 * created on the first tap, so a pass nobody tapped has nothing to update).
 */
function matching(s: ReissueScope): { from: string; params: string[] } {
  return {
    from: `wallet_provider_instances i
      ${s.templateId === undefined ? '' : 'JOIN passes p ON p.id = i.pass_id AND p.template_id = ?'}
      WHERE i.org_id = ? AND i.mode = ? AND i.provider = ? AND i.lifecycle = 'active'
        AND i.retirement_requested_at IS NULL`,
    params: [...(s.templateId === undefined ? [] : [s.templateId]), s.orgId, s.mode, s.provider],
  };
}

export async function countReissueInstances(db: D1Database, s: ReissueScope): Promise<number> {
  const { from, params } = matching(s);
  const row = await first<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${from}`, params);
  return row?.n ?? 0;
}

/** One page of instance ids after `after`, in id order. */
export async function listReissueInstanceIds(
  db: D1Database,
  s: ReissueScope,
  after: string,
  limit: number,
): Promise<string[]> {
  const { from, params } = matching(s);
  const rows = await all<{ id: string }>(
    db,
    `SELECT i.id FROM ${from} AND i.id > ? ORDER BY i.id LIMIT ?`,
    [...params, after, limit],
  );
  return rows.map((r) => r.id);
}
