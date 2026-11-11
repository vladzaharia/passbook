import type { Mode } from '../../../shared/contracts/common.ts';
import { all, likeEscape } from '../../platform/db.ts';
import { mapPass, PASS_SELECT, type Pass, type PassDbRow, type PassStatus } from './repo-map.ts';

export interface PassListFilter {
  orgId?: string | null;
  /** The caller's mode; admin and API lists always set it. */
  mode?: Mode;
  templateId?: string;
  /** Any of these templates. */
  templateIds?: string[];
  connectionId?: string;
  /** `voided` leaves out removed passes; `removed` is those alone. */
  status?: PassStatus | 'removed';
  holderEmail?: string;
  holderState?: 'unassigned' | 'waiting' | 'owned';
  onDevice?: boolean;
  /** Skips passes removed from Wallet. */
  excludeRemoved?: boolean;
  q?: string;
  cursor?: string;
  limit: number;
}

const HOLDER_STATE_SQL = {
  unassigned: 'holder_email IS NULL AND owner_user_id IS NULL',
  waiting: 'holder_email IS NOT NULL AND owner_user_id IS NULL',
  owned: 'owner_user_id IS NOT NULL',
} as const;

/** The WHERE clauses and parameters for a filter, shared by lists and counts. */
export function passFilterSql(filter: PassListFilter): {
  where: string[];
  params: (string | number)[];
} {
  const where: string[] = ['deleted_at IS NULL', 'test_data_quarantined = 0'];
  const params: (string | number)[] = [];
  const add = (sql: string, ...values: (string | number)[]) => {
    where.push(sql);
    params.push(...values);
  };
  if (filter.orgId) add('org_id = ?', filter.orgId);
  if (filter.mode) add('mode = ?', filter.mode);
  if (filter.templateId) add('template_id = ?', filter.templateId);
  if (filter.templateIds?.length)
    add(`template_id IN (${filter.templateIds.map(() => '?').join(', ')})`, ...filter.templateIds);
  if (filter.connectionId) add('connection_id = ?', filter.connectionId);
  if (filter.status === 'removed') where.push('removed_at IS NOT NULL');
  else if (filter.status) {
    add('status = ?', filter.status);
    if (filter.status === 'voided') where.push('removed_at IS NULL');
  }
  if (filter.holderEmail) add('holder_email = ?', filter.holderEmail);
  if (filter.holderState) where.push(HOLDER_STATE_SQL[filter.holderState]);
  if (filter.onDevice !== undefined)
    where.push(
      `${filter.onDevice ? '' : 'NOT '}EXISTS (SELECT 1 FROM registrations r WHERE r.pass_id = passes.id)`,
    );
  if (filter.excludeRemoved) where.push('removed_at IS NULL');
  if (filter.cursor) add('id < ?', filter.cursor);
  const q = filter.q?.trim();
  if (q) {
    // One indexed prefix lookup per column (NOCASE indexes), merged by id: an OR of LIKEs scans.
    const prefix = `${likeEscape(q)}%`;
    const like = (column: string) => `SELECT id FROM passes WHERE ${column} LIKE ? ESCAPE '\\'`;
    add(
      `id IN (${[
        like('display_title'),
        like('display_subtitle'),
        like('external_id'),
        like('holder_email'),
        'SELECT id FROM passes WHERE serial = ?',
      ].join(' UNION ')})`,
      prefix,
      prefix,
      prefix,
      prefix,
      q,
    );
  }
  return { where, params };
}

/** Newest first by id (UUIDv7). Search is prefix-only on display fields, exact on serial. */
export async function listPasses(
  db: D1Database,
  filter: PassListFilter,
): Promise<{ items: Pass[]; nextCursor: string | null }> {
  const { where, params } = passFilterSql(filter);
  const rows = await all<PassDbRow>(
    db,
    `${PASS_SELECT} WHERE ${where.join(' AND ')}
      AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
        WHERE t.pass_id = passes.id AND t.state = 'pending')
      ORDER BY id DESC LIMIT ?`,
    [...params, filter.limit + 1],
  );
  const page = rows.slice(0, filter.limit).map(mapPass);
  const last = page.at(-1);
  return { items: page, nextCursor: rows.length > filter.limit && last ? last.id : null };
}
