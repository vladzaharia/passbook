import { first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';

export interface ScanSeed {
  staffId: string;
  scannerId: string | null;
  at: number;
  org?: string;
  mode?: 'live' | 'test';
  state?: 'done' | 'pending' | 'failed';
  outcome?: 'ok' | 'heads_up' | 'refused' | null;
  reason?: 'not_found' | 'ambiguous' | null;
  actionKind?: 'check_in' | 'undo' | null;
  undoneAt?: number | null;
  undoneBy?: string | null;
  passless?: boolean;
}

type Binding = {
  id: string;
  kind: string;
  device_role: string;
  staff_id: string | null;
  staff_since: number | null;
  staff_seen_at: number | null;
};

export async function resetStaffAdminFixture(env: AppEnv) {
  await run(env.DB, 'DELETE FROM audit_log');
  await run(env.DB, 'DELETE FROM counters');
}

export function extendStaffAdminSession(db: D1Database, id: string, expiresAt: number) {
  return run(db, 'UPDATE sessions SET idle_expires_at = ? WHERE user_id = ?', [expiresAt, id]);
}

export function staffBinding(db: D1Database, id: string) {
  return first<Binding>(
    db,
    'SELECT id, kind, device_role, staff_id, staff_since, staff_seen_at FROM scanners WHERE id = ?',
    [id],
  );
}

export function staffCredential(db: D1Database, id: string) {
  return first<{ pin_hash: string; pin_set_at: number; disabled_at: number | null }>(
    db,
    'SELECT pin_hash, pin_set_at, disabled_at FROM scan_staff WHERE id = ?',
    [id],
  );
}

export function insertStaffActivityScan(
  db: D1Database,
  options: {
    id: string;
    scanOrg: string;
    scanMode: 'live' | 'test';
    pass: { passId: string; templateId: string } | undefined;
    input: ScanSeed;
  },
) {
  const { id, scanOrg, scanMode, pass, input } = options;
  return run(
    db,
    `INSERT INTO scans
        (id, org_id, mode, pass_id, template_id, scanner_id, actor_type, actor_id, actor_key, staff_id,
         idempotency_key, request_hash, method, state, outcome, reason, action_kind, undone_at, undone_by, at)
       VALUES (?, ?, ?, ?, ?, ?, 'scanner', ?, ?, ?, ?, 'hash', 'camera', ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      scanOrg,
      scanMode,
      pass?.passId ?? null,
      pass?.templateId ?? null,
      input.scannerId,
      input.scannerId ?? 'removed-scanner',
      `s:${input.scannerId ?? 'removed-scanner'}`,
      input.staffId,
      id,
      input.state ?? 'done',
      input.outcome === undefined ? 'ok' : input.outcome,
      input.reason ?? null,
      input.actionKind === undefined ? 'check_in' : input.actionKind,
      input.undoneAt ?? null,
      input.undoneBy ?? null,
      input.at,
    ],
  );
}
