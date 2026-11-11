import type { Mode } from '../../../shared/contracts/common.ts';
import { all, chunk, first, placeholders } from '../../platform/db.ts';
import { readMode, type ScopeArg, scopeOrg } from '../passes/scope.ts';
import { type HolderDbRow, type HolderPass, mapHolder, SELECT_HOLDER } from './repo.ts';

/** Missing or out-of-scope ids are absent from the result. */
export async function getHolderPasses(
  db: D1Database,
  passIds: string[],
  scope: ScopeArg,
): Promise<Map<string, HolderPass>> {
  const orgScope = scopeOrg(scope);
  const mode = readMode(scope);
  const out = new Map<string, HolderPass>();
  for (const ids of chunk([...new Set(passIds)], 90)) {
    const rows = await all<HolderDbRow>(
      db,
      `${SELECT_HOLDER} WHERE p.id IN (${placeholders(ids.length)}) AND p.deleted_at IS NULL
         AND p.test_data_quarantined = 0
         AND (? IS NULL OR p.org_id = ?) AND (? IS NULL OR p.mode = ?)`,
      [...ids, orgScope, orgScope, mode, mode],
    );
    for (const row of rows) out.set(row.id, mapHolder(row));
  }
  return out;
}

export interface HolderFilter {
  orgId: string;
  email?: string;
  state?: 'unassigned' | 'waiting' | 'owned';
  /** Only passes of this mode. Absent: every mode. */
  mode?: Mode;
  cursor?: string;
  limit: number;
}

export async function listHolderPasses(
  db: D1Database,
  filter: HolderFilter,
): Promise<{ items: HolderPass[]; nextCursor: string | null }> {
  const where: string[] = ['p.org_id = ?', 'p.deleted_at IS NULL', 'p.test_data_quarantined = 0'];
  const params: (string | number)[] = [filter.orgId];
  if (filter.mode) {
    where.push('p.mode = ?');
    params.push(filter.mode);
  }
  if (filter.email) {
    where.push('p.holder_email = ?');
    params.push(filter.email);
  }
  if (filter.state === 'unassigned')
    where.push('p.holder_email IS NULL AND p.owner_user_id IS NULL');
  if (filter.state === 'waiting')
    where.push('p.holder_email IS NOT NULL AND p.owner_user_id IS NULL');
  if (filter.state === 'owned') where.push('p.owner_user_id IS NOT NULL');
  if (filter.cursor) {
    where.push('p.id < ?');
    params.push(filter.cursor);
  }
  const rows = await all<HolderDbRow>(
    db,
    `${SELECT_HOLDER} WHERE ${where.join(' AND ')} ORDER BY p.id DESC LIMIT ?`,
    [...params, filter.limit + 1],
  );
  const page = rows.slice(0, filter.limit).map(mapHolder);
  const last = page.at(-1);
  return { items: page, nextCursor: rows.length > filter.limit && last ? last.id : null };
}

export async function userVerifiedEmail(
  db: D1Database,
  userId: string,
  email: string,
): Promise<boolean> {
  const row = await first<{ ok: number }>(
    db,
    `SELECT 1 AS ok FROM users u WHERE u.id = ?1 AND u.status = 'active'
       AND EXISTS (SELECT 1 FROM user_emails e WHERE e.user_id = u.id AND e.email = ?2)`,
    [userId, email],
  );
  return row !== null;
}

/** Candidates for the verified-email hook; each is transferred under its own source fence. */
export async function waitingPassIds(db: D1Database, email: string): Promise<string[]> {
  const rows = await all<{ id: string }>(
    db,
    `SELECT p.id FROM passes p
     WHERE p.holder_email = ? AND p.owner_user_id IS NULL
       AND p.deleted_at IS NULL AND p.test_data_quarantined = 0
       AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
         WHERE t.pass_id = p.id AND t.state = 'pending')`,
    [email],
  );
  return rows.map((row) => row.id);
}
