import type { PassJson } from '../../../passkit/types.ts';
import type { Envelope } from '../../platform/crypto.ts';
import { all, first, run } from '../../platform/db.ts';

export type GoogleMessageState =
  | 'pending'
  | 'sending'
  | 'notified'
  | 'text'
  | 'failed'
  | 'unknown'
  | 'superseded';
export type GoogleMessageReason =
  | 'budget'
  | 'quota'
  | 'refused'
  | 'unconfirmed'
  | 'rate_limited'
  | 'not_sent';

export interface GoogleMessageRow {
  id: string;
  instanceId: string;
  operationId: string;
  baseVersion: number;
  targetVersion: number;
  notify: boolean;
  state: GoogleMessageState;
  tries: number;
  settledAt: number | null;
  envelope: Envelope;
}

interface Raw {
  id: string;
  instance_id: string;
  operation_id: string;
  base_version: number;
  target_version: number;
  notify: number;
  state: GoogleMessageState;
  tries: number;
  settled_at: number | null;
  kek_version: number;
  iv: ArrayBuffer;
  wrapped_dek: ArrayBuffer;
  ciphertext: ArrayBuffer;
}

const COLUMNS = `id, instance_id, operation_id, base_version, target_version, notify, state, tries, settled_at,
  kek_version, iv, wrapped_dek, ciphertext`;

const mapRow = (r: Raw): GoogleMessageRow => ({
  id: r.id,
  instanceId: r.instance_id,
  operationId: r.operation_id,
  baseVersion: r.base_version,
  targetVersion: r.target_version,
  notify: r.notify === 1,
  state: r.state,
  tries: r.tries,
  settledAt: r.settled_at,
  envelope: {
    kekVersion: r.kek_version,
    iv: new Uint8Array(r.iv),
    wrappedDek: new Uint8Array(r.wrapped_dek),
    ciphertext: new Uint8Array(r.ciphertext),
  },
});

export async function getGoogleMessage(
  db: D1Database,
  instanceId: string,
  baseVersion: number,
  targetVersion: number,
): Promise<GoogleMessageRow | null> {
  const row = await first<Raw>(
    db,
    `SELECT ${COLUMNS} FROM wallet_google_messages
     WHERE instance_id = ? AND base_version = ? AND target_version = ?`,
    [instanceId, baseVersion, targetVersion],
  );
  return row ? mapRow(row) : null;
}

/** The message left `sending` by a crashed try, if any (at most one is open: 0197). */
export async function getSendingGoogleMessage(
  db: D1Database,
  instanceId: string,
): Promise<GoogleMessageRow | null> {
  const row = await first<Raw>(
    db,
    `SELECT ${COLUMNS} FROM wallet_google_messages WHERE instance_id = ? AND state = 'sending'`,
    [instanceId],
  );
  return row ? mapRow(row) : null;
}

/** Delivered messages (notified or text) settled after `since`, newest first. */
export async function listDeliveredGoogleMessages(
  db: D1Database,
  instanceId: string,
  since: number,
  limit: number,
): Promise<GoogleMessageRow[]> {
  const rows = await all<Raw>(
    db,
    `SELECT ${COLUMNS} FROM wallet_google_messages
     WHERE instance_id = ? AND state IN ('notified', 'text') AND settled_at > ?
     ORDER BY settled_at DESC, id DESC LIMIT ?`,
    [instanceId, since, limit],
  );
  return rows.map(mapRow);
}

/**
 * The version the object last carried: the newer of the last succeeded upsert and the last message that was
 * sent or settled (a message never re-announces a version it already covered).
 */
export async function googleMessageBase(
  db: D1Database,
  instanceId: string,
): Promise<number | null> {
  const row = await first<{ base: number | null }>(
    db,
    `SELECT MAX(v) AS base FROM (
       SELECT MAX(pass_version) AS v FROM wallet_provider_instance_operations
         WHERE instance_id = ? AND kind = 'upsert' AND state = 'succeeded'
       UNION ALL
       SELECT MAX(target_version) FROM wallet_google_messages
         WHERE instance_id = ? AND state IN ('sending', 'notified', 'text', 'failed', 'unknown'))`,
    [instanceId, instanceId],
  );
  return row?.base ?? null;
}

const MAX_MIDDLE = 19;

/**
 * `[base, ...stored versions strictly between, target]`, read by exact version. More than 19 in between: the base
 * and the target only. Null when the base row or the target row is missing (purged, or a metadata-only bump).
 */
export async function readPassVersionRange(
  db: D1Database,
  passId: string,
  base: number,
  target: number,
): Promise<PassJson[] | null> {
  const exact = (version: number) =>
    first<{ pass_json: string }>(
      db,
      `SELECT pass_json FROM pass_versions
       WHERE pass_id = ? AND version = ? AND pass_json IS NOT NULL AND purged_at IS NULL`,
      [passId, version],
    );
  const [baseRow, targetRow] = [await exact(base), await exact(target)];
  if (!baseRow || !targetRow) return null;
  const middle = await all<{ pass_json: string }>(
    db,
    `SELECT pass_json FROM pass_versions
     WHERE pass_id = ? AND version > ? AND version < ? AND pass_json IS NOT NULL AND purged_at IS NULL
     ORDER BY version LIMIT ?`,
    [passId, base, target, MAX_MIDDLE + 1],
  );
  const rows = middle.length > MAX_MIDDLE ? [] : middle;
  try {
    return [baseRow, ...rows, targetRow].map((r) => JSON.parse(r.pass_json) as PassJson);
  } catch {
    return null;
  }
}

const PURGE_AFTER_MS = 35 * 24 * 60 * 60 * 1000;

/** Settled and superseded rows older than 35 days; open rows stay (they are the at-most-once evidence). */
export async function purgeGoogleMessages(
  db: D1Database,
  now: number,
  limit: number,
): Promise<void> {
  const before = now - PURGE_AFTER_MS;
  await run(
    db,
    `DELETE FROM wallet_google_messages WHERE id IN (
       SELECT id FROM wallet_google_messages WHERE settled_at IS NOT NULL AND settled_at < ?
       ORDER BY settled_at LIMIT ?)`,
    [before, limit],
  );
  await run(
    db,
    `DELETE FROM wallet_google_messages WHERE id IN (
       SELECT id FROM wallet_google_messages WHERE state = 'superseded' AND created_at < ?
       ORDER BY created_at LIMIT ?)`,
    [before, limit],
  );
}
