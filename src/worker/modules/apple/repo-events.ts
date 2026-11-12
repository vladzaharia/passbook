import { first, stmt } from '../../platform/db.ts';
import type { EventRow } from '../events/repo.ts';

export interface AppleEventCredential {
  serial: string;
  credentialGeneration: number;
}

/** Wallet events may be prepared asynchronously, so commit only to their captured incarnation. */
export function appleEventStmt(
  db: D1Database,
  row: EventRow,
  credential: AppleEventCredential,
): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO pass_events
    (id, org_id, pass_id, mode, kind, device, actor_type, actor_id, data, at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM passes p WHERE p.id = ? AND p.org_id = ? AND p.mode = ?
      AND p.serial = ? AND p.credential_generation = ? AND p.test_data_quarantined = 0
      AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = p.org_id AND o.status = 'active')
      AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
        WHERE t.pass_id = p.id AND t.state = 'pending'))`,
    [
      row.id,
      row.org_id,
      row.pass_id,
      row.mode,
      row.kind,
      row.device,
      row.actor_type,
      row.actor_id,
      row.data,
      row.at,
      row.pass_id,
      row.org_id,
      row.mode,
      credential.serial,
      credential.credentialGeneration,
    ],
  );
}

/** Do not attribute a new credential's fetch to an earlier holder's Wallet check-in. */
export async function pendingAppleFetchDevice(
  db: D1Database,
  passId: string,
  serial: string,
  generation: number,
  since: number,
): Promise<string[]> {
  const row = await first<{ device: string }>(
    db,
    `SELECT l.device FROM pass_events l
    JOIN passes p ON p.id = l.pass_id
    WHERE l.pass_id = ? AND p.serial = ? AND p.credential_generation = ?
      AND p.test_data_quarantined = 0
      AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = p.org_id AND o.status = 'active')
      AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
        WHERE t.pass_id = p.id AND t.state = 'pending')
      AND l.kind = 'device.fetched' AND l.at >= ? AND l.device IS NOT NULL
      AND json_extract(l.data, '$.step') = 'listed'
      AND json_extract(l.data, '$.appleGeneration') = ?
      AND NOT EXISTS (SELECT 1 FROM pass_events f WHERE f.pass_id = l.pass_id
        AND f.device = l.device AND f.kind = 'device.fetched'
        AND json_extract(f.data, '$.step') = 'file'
        AND json_extract(f.data, '$.appleGeneration') = ? AND f.at >= l.at)
    ORDER BY l.at, l.id LIMIT 1`,
    [passId, serial, generation, since, generation, generation],
  );
  return row ? [row.device] : [];
}
