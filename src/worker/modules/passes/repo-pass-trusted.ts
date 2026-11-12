import { batch, first, stmt } from '../../platform/db.ts';
import type { Pass } from './repo-map.ts';
import {
  type RefreshSnapshot,
  refreshParams,
  refreshPredicate,
  validRefreshEpochs,
} from './repo-refresh-snapshot.ts';

// Raw writes for callers that hold no tenant authority (holder refresh, fixtures, service tests). Tenant
// requests take the grants in repo-pass-grants.ts; this file is allowlisted in tools/authority-scope.ts.

/** Rotate only the captured credential/lifecycle incarnation. */
export async function setDownloadToken(
  db: D1Database,
  pass: Pass,
  token: string,
  now: number,
): Promise<boolean> {
  if (
    !Number.isSafeInteger(pass.credentialGeneration) ||
    pass.credentialGeneration < 1 ||
    !Number.isSafeInteger(pass.lifecycleGeneration) ||
    pass.lifecycleGeneration < 0
  )
    return false;
  const row = await first<{ id: string }>(
    db,
    `UPDATE passes SET download_token = ?, download_token_rotated_at = ?, link_generation = link_generation + 1
     WHERE id = ?
       AND credential_generation = ? AND lifecycle_generation = ?
       AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = passes.id AND t.state = 'pending')
     RETURNING id`,
    [token, now, pass.id, pass.credentialGeneration, pass.lifecycleGeneration],
  );
  return row !== null;
}

/** Claims the slot only while the selected context  still match. */
export async function claimRefresh(
  db: D1Database,
  snapshot: RefreshSnapshot,
  now: number,
  windowMs: number,
): Promise<boolean> {
  if (!validRefreshEpochs(snapshot)) return false;
  const row = await first<{ id: string }>(
    db,
    `UPDATE passes SET refresh_requested_at = ?
     WHERE id = ? AND ${refreshPredicate}
       AND (refresh_requested_at IS NULL OR refresh_requested_at <= ?)
     RETURNING id`,
    [now, snapshot.passId, ...refreshParams(snapshot), now - windowMs],
  );
  return row !== null;
}

/**
 * Hides the pass from every list and lookup but the device protocol, and unlinks it from its
 * owner and connection. The retention job removes it later. Trusted callers only; tenants use the grant.
 * The owner leaves only behind an attach block (0055 trigger), written under the same fence.
 */
export async function softDeletePass(db: D1Database, pass: Pass, now: number): Promise<boolean> {
  const fence = `id = ? AND org_id = ? AND mode = ?
       AND template_id = ? AND template_version = ? AND serial = ? AND auth_token = ?
       AND holder_email IS ? AND owner_user_id IS ? AND version = ? AND link_generation = ?
       AND object_key = ? AND download_token = ? AND status = ? AND removed_at IS ?
       AND connection_id IS ? AND external_ref IS ? AND deleted_at IS NULL AND test_data_quarantined = 0`;
  const params = [
    pass.id,
    pass.orgId,
    pass.mode,
    pass.templateId,
    pass.templateVersion,
    pass.serial,
    pass.authToken,
    pass.holderEmail,
    pass.ownerUserId,
    pass.version,
    pass.linkGeneration,
    pass.objectKey,
    pass.downloadToken,
    pass.status,
    pass.removedAt,
    pass.connectionId,
    pass.externalRef,
  ];
  const [, deleted] = await batch(db, [
    stmt(
      db,
      `INSERT OR IGNORE INTO pass_attach_blocks (pass_id, user_id, created_at)
       SELECT id, owner_user_id, ? FROM passes WHERE ${fence} AND owner_user_id IS NOT NULL`,
      [now, ...params],
    ),
    stmt(
      db,
      `UPDATE passes SET deleted_at = ?, owner_user_id = NULL, connection_id = NULL, external_ref = NULL,
       next_sync_at = NULL WHERE ${fence} RETURNING id`,
      [now, ...params],
    ),
  ]);
  return (deleted?.results?.length ?? 0) === 1;
}
