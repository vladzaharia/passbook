import { first } from '../../platform/db.ts';

/**
 * When the pass was last voided: its newest `pass.voided` event, else its newest `pass.void` audit
 * row. Both reads are tenant-scoped and indexed (pass_events_pass, audit_target). Null if neither.
 */
export async function voidedAt(
  db: D1Database,
  orgId: string,
  passId: string,
): Promise<number | null> {
  const event = await first<{ at: number }>(
    db,
    `SELECT at FROM pass_events WHERE pass_id = ? AND org_id = ? AND kind = 'pass.voided'
     ORDER BY at DESC, id DESC LIMIT 1`,
    [passId, orgId],
  );
  if (event) return event.at;
  const audit = await first<{ at: number }>(
    db,
    `SELECT at FROM audit_log WHERE target_type = 'pass' AND target_id = ? AND org_id = ?
       AND action = 'pass.void' ORDER BY at DESC LIMIT 1`,
    [passId, orgId],
  );
  return audit?.at ?? null;
}
