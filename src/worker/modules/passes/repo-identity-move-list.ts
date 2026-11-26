import { all } from '../../platform/db.ts';
import { COLUMNS, type MoveRow, type MoveState } from './repo-identity-move.ts';

/** Move rows for the console list, in id order after `after`; every filter is optional. */
export function listMoves(
  db: D1Database,
  q: {
    orgId?: string;
    opId?: string;
    state?: MoveState;
    reason?: string;
    after: string;
    limit: number;
  },
): Promise<MoveRow[]> {
  const where = ['id > ?'];
  const args: (string | number)[] = [q.after];
  // `wallet_copy` finds every `wallet_copy:<provider>` row.
  if (q.reason !== undefined) {
    where.push("(reason = ? OR reason LIKE ? || ':%')");
    args.push(q.reason, q.reason);
  }
  for (const [column, value] of [
    ['org_id', q.orgId],
    ['op_id', q.opId],
    ['state', q.state],
  ] as const)
    if (value !== undefined) {
      where.push(`${column} = ?`);
      args.push(value);
    }
  return all<MoveRow>(
    db,
    `SELECT ${COLUMNS} FROM pass_moves WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`,
    [...args, q.limit],
  );
}
