import { first } from '../../platform/db.ts';
import { keyLive } from '../../platform/repo-api-key-sql.ts';
import { keyActsAsTerminalSql } from './repo-sandbox-terminal-sql.ts';

/** The key still acts as this terminal: not revoked or expired, in its org and mode, a till key bound to it or a sandbox key on the sandbox terminal. */
export async function apiKeyActs(
  db: D1Database,
  key: { id: string; orgId: string; mode: string; scannerId: string },
  now: number,
): Promise<boolean> {
  const live = keyLive('k', now);
  const acts = keyActsAsTerminalSql();
  const row = await first<{ ok: number }>(
    db,
    `SELECT 1 AS ok FROM api_keys k
     WHERE k.id = ? AND k.org_id = ? AND k.mode = ? AND ${live.sql}
       AND ${acts.sql}`,
    [key.id, key.orgId, key.mode, ...live.params, ...acts.bind(key.scannerId)],
  );
  return row !== null;
}

/** Whether the key may act as this terminal: minted for it, or a sandbox key and the sandbox terminal. */
export async function keyBoundTo(
  db: D1Database,
  keyId: string,
  scannerId: string,
): Promise<boolean> {
  const acts = keyActsAsTerminalSql();
  const row = await first<{ ok: number }>(
    db,
    `SELECT 1 AS ok FROM api_keys k WHERE k.id = ? AND ${acts.sql}`,
    [keyId, ...acts.bind(scannerId)],
  );
  return row !== null;
}

/** The open sandbox's terminal (named by `x-passbook-device: sandbox`), or null when none is live: not made yet, revoked or expired. */
export async function sandboxTerminalIdOf(
  db: D1Database,
  orgId: string,
  now: number,
): Promise<string | null> {
  const row = await first<{ id: string }>(
    db,
    `SELECT s.id FROM developer_sandboxes d JOIN scanners s ON s.id = d.terminal_id
     WHERE d.org_id = ? AND d.closed_at IS NULL AND s.revoked_at IS NULL
       AND (s.expires_at IS NULL OR s.expires_at > ?)`,
    [orgId, now],
  );
  return row?.id ?? null;
}

/** The org's `access_revision`, captured with the key so a suspend or membership change since refuses at commit. */
export async function orgAccessRevisionOf(db: D1Database, orgId: string): Promise<number | null> {
  const row = await first<{ access_revision: number }>(
    db,
    'SELECT access_revision FROM orgs WHERE id = ?',
    [orgId],
  );
  return row?.access_revision ?? null;
}
