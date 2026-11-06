import type { CheckInPolicy } from '../../../shared/contracts/check-in.ts';
import { CheckInPolicySchema } from '../../../shared/contracts/check-in.ts';
import { first, run } from '../../platform/db.ts';

export async function passCheckIn(db: D1Database, orgId: string, passId: string) {
  const row = await first<{ rules: string; updated_at: number }>(
    db,
    'SELECT rules,updated_at FROM pass_check_in WHERE org_id=? AND pass_id=?',
    [orgId, passId],
  );
  return {
    rules: CheckInPolicySchema.parse(JSON.parse(row?.rules ?? '{}')),
    updatedAt: row?.updated_at ?? null,
  };
}

export const savePassCheckIn = (
  db: D1Database,
  orgId: string,
  passId: string,
  rules: CheckInPolicy,
  at: number,
) =>
  run(
    db,
    `INSERT INTO pass_check_in(pass_id,org_id,rules,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(pass_id) DO UPDATE SET rules=excluded.rules,updated_at=excluded.updated_at
    WHERE pass_check_in.org_id=excluded.org_id`,
    [passId, orgId, JSON.stringify(rules), at],
  );
