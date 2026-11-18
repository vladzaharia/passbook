import { first, run } from '../../platform/db.ts';

/** An open schedule or admin run of the connection other than `instanceId`, with its tracking row. */
export async function openRunOf(
  db: D1Database,
  p: { connectionId: string; instanceId: string },
): Promise<{
  id: string;
  startedAt: number;
  status: string | null;
  tipSeq: number;
  trigger: 'schedule' | 'admin';
  keyset: string | null;
  generation: number | null;
} | null> {
  const row = await first<{
    id: string;
    started_at: number;
    status: string | null;
    tip_seq: number | null;
    trigger: 'schedule' | 'admin';
    keyset: string | null;
    generation: number | null;
  }>(
    db,
    `SELECT r.id, r.started_at, w.status, w.tip_seq, r.trigger,
       w.credential_keyset_commitment AS keyset, w.generation FROM connection_runs r
     LEFT JOIN workflow_runs w ON w.instance_id = r.id AND w.kind = 'connection_sync'
       AND w.target_id = r.connection_id
     WHERE r.connection_id = ? AND r.id <> ? AND r.outcome = 'running'
       AND r.trigger IN ('schedule', 'admin') AND r.pass_id IS NULL
     ORDER BY r.started_at DESC LIMIT 1`,
    [p.connectionId, p.instanceId],
  );
  return row
    ? {
        id: row.id,
        startedAt: row.started_at,
        status: row.status,
        tipSeq: row.tip_seq ?? 0,
        trigger: row.trigger,
        keyset: row.keyset,
        generation: row.generation,
      }
    : null;
}

/** Remember the newest continuation of a run (never moves back). */
export async function setChainTip(
  db: D1Database,
  p: { instanceId: string; connectionId: string; seq: number },
): Promise<void> {
  await run(
    db,
    `UPDATE workflow_runs SET tip_seq = ? WHERE instance_id = ? AND kind = 'connection_sync'
       AND target_id = ? AND tip_seq < ?`,
    [p.seq, p.instanceId, p.connectionId, p.seq],
  );
}
