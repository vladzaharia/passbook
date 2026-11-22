import type { BroadcastKind, BroadcastState } from '../../../shared/contracts/broadcasts.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { all } from '../../platform/db.ts';
import type { BroadcastRow } from './repo.ts';

export interface BroadcastListFilter {
  orgId: string;
  mode: Mode;
  state?: BroadcastState | undefined;
  /** Default `manual`: leaves out the runs of automatic messages. */
  origin?: 'manual' | 'rule' | undefined;
  kind?: BroadcastKind | undefined;
  /** Only the runs of this automatic message. */
  ruleId?: string | undefined;
  /** Only the undo run of this change. */
  parentId?: string | undefined;
  /** Only the run that resumed this change. */
  retryOf?: string | undefined;
  cursor?: string | undefined;
  limit: number;
}

export async function listBroadcasts(
  db: D1Database,
  f: BroadcastListFilter,
): Promise<{ rows: BroadcastRow[]; nextCursor: string | null }> {
  const where = ['org_id = ?', 'mode = ?'];
  const params: (string | number)[] = [f.orgId, f.mode];
  if (f.state) {
    where.push('state = ?');
    params.push(f.state);
  }
  if (f.kind) {
    where.push('kind = ?');
    params.push(f.kind);
  }
  where.push(f.origin === 'rule' ? 'rule_id IS NOT NULL' : 'rule_id IS NULL');
  if (f.ruleId) {
    where.push('rule_id = ?');
    params.push(f.ruleId);
  }
  if (f.parentId) {
    where.push('parent_id = ?');
    params.push(f.parentId);
  }
  if (f.retryOf) {
    where.push('retry_of = ?');
    params.push(f.retryOf);
  }
  if (f.cursor) {
    where.push('id < ?');
    params.push(f.cursor);
  }
  const rows = await all<BroadcastRow>(
    db,
    `SELECT * FROM broadcasts WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`,
    [...params, f.limit + 1],
  );
  const page = rows.slice(0, f.limit);
  const last = page.at(-1);
  return { rows: page, nextCursor: rows.length > f.limit && last ? last.id : null };
}
