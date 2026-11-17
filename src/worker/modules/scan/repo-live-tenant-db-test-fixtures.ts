import { first, run } from '../../platform/db.ts';
import type { ScanKit } from './test-kit.ts';

interface StoredSession {
  id_hash: string;
  user_id: string;
  amr: string;
  roles: string;
  csrf_secret: string;
  created_at: number;
  last_seen_at: number;
  idle_expires_at: number;
  expires_at: number;
  revoked_at: number | null;
  ip_prefix: string | null;
  user_agent: string | null;
}

export async function storedSession(kit: ScanKit, id: string): Promise<StoredSession> {
  const row = await first<StoredSession>(kit.env.DB, 'SELECT * FROM sessions WHERE id_hash=?', [
    id,
  ]);
  if (!row) throw new Error('Missing platform session.');
  return row;
}

export function insertSession(kit: ScanKit, row: StoredSession, secret: string) {
  return run(
    kit.env.DB,
    `INSERT INTO sessions
    (id_hash,user_id,amr,roles,csrf_secret,created_at,last_seen_at,idle_expires_at,
     expires_at,revoked_at,ip_prefix,user_agent) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      row.id_hash,
      row.user_id,
      row.amr,
      row.roles,
      secret,
      row.created_at,
      row.last_seen_at,
      row.idle_expires_at,
      row.expires_at,
      row.revoked_at,
      row.ip_prefix,
      row.user_agent,
    ],
  );
}

export function revokeLiveTenantFixtureMembership(db: D1Database, revokedAt: number, id: string) {
  return run(db, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [revokedAt, id]);
}
