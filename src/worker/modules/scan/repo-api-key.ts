import { SANDBOX_TERMINAL_NAME } from '../../../shared/copy/developer.ts';
import { first } from '../../platform/db.ts';
import { keyLive } from '../../platform/repo-api-key-sql.ts';
import { keyActsAsTerminalSql } from './sandbox-terminal-sql.ts';

/** The key still acts as this terminal: not revoked or expired, in its org and mode, a till key bound to it or a sandbox key on the sandbox terminal. */
export async function apiKeyActs(
  db: D1Database,
  key: { id: string; orgId: string; mode: string; scannerId: string },
  now: number,
): Promise<boolean> {
  const live = keyLive('k', now);
  const row = await first<{ ok: number }>(
    db,
    `SELECT 1 AS ok FROM api_keys k
     WHERE k.id = ? AND k.org_id = ? AND k.mode = ? AND ${live.sql}
       AND ${keyActsAsTerminalSql()}`,
    [key.id, key.orgId, key.mode, ...live.params, key.scannerId, key.scannerId],
  );
  return row !== null;
}

/** Whether the key may act as this terminal: minted for it, or a sandbox key and the sandbox terminal. */
export async function keyBoundTo(
  db: D1Database,
  keyId: string,
  scannerId: string,
): Promise<boolean> {
  const row = await first<{ ok: number }>(
    db,
    `SELECT 1 AS ok FROM api_keys k WHERE k.id = ? AND ${keyActsAsTerminalSql()}`,
    [keyId, scannerId, scannerId],
  );
  return row !== null;
}

/** The org's sandbox terminal (named by `x-passbook-device: sandbox`), or null. */
export async function sandboxTerminalIdOf(db: D1Database, orgId: string): Promise<string | null> {
  const row = await first<{ id: string }>(
    db,
    `SELECT id FROM scanners WHERE org_id = ? AND mode = 'test' AND kind = 'terminal' AND name = ?
       AND revoked_at IS NULL`,
    [orgId, SANDBOX_TERMINAL_NAME],
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
