import {
  type IssuedToken,
  type SealRow,
  sealStatement,
  type TokenPurpose,
} from '../../platform/capability-token.ts';
import { batch, first, stmt } from '../../platform/db.ts';
import type { Pass } from './repo-map.ts';
import {
  type RefreshSnapshot,
  refreshParams,
  refreshPredicate,
  validRefreshEpochs,
} from './repo-refresh-snapshot.ts';
import {
  BUNDLE_RESERVED,
  PASS_PENDING,
  PASS_RESERVED,
  type PlainTokenRow,
} from './repo-token-seal.ts';

// Raw writes for callers that hold no tenant authority (holder refresh, fixtures, service tests). Tenant
// requests take the grants in repo-pass-grants.ts; this file is allowlisted in tools/authority-scope.ts.

/** Rotate only the captured credential/lifecycle incarnation. */
export async function setDownloadToken(
  db: D1Database,
  pass: Pass,
  token: IssuedToken,
  now: number,
): Promise<boolean> {
  if (
    !Number.isSafeInteger(pass.credentialGeneration) ||
    pass.credentialGeneration < 1 ||
    !Number.isSafeInteger(pass.lifecycleGeneration) ||
    pass.lifecycleGeneration < 0
  )
    return false;
  const [updated] = await batch(db, [
    stmt(
      db,
      `UPDATE passes SET download_token = ?, download_token_rotated_at = ?, link_generation = link_generation + 1
     WHERE id = ?
       AND credential_generation = ? AND lifecycle_generation = ?
       AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = passes.id AND t.state = 'pending')
     RETURNING id`,
      [token.mac, now, pass.id, pass.credentialGeneration, pass.lifecycleGeneration],
    ),
    sealStatement(db, 'pass', pass.id, token.mac, token.seal),
  ]);
  return (updated?.results.length ?? 0) === 1;
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

/**
 * Seals the row of an org no job grant can write (suspended, deleted). Sealing changes no authority, so it
 * is a plain batch: the update holds only for the plain token read, the copy only for the row that took it.
 */
export async function sealTrusted(
  db: D1Database,
  purpose: TokenPurpose,
  row: PlainTokenRow,
  mac: string,
  seal: SealRow | null,
): Promise<boolean> {
  const [updated] = await batch(db, [
    stmt(db, SEAL_SQL[purpose], [mac, row.id, row.token]),
    ...(seal ? [sealStatement(db, purpose, row.id, mac, seal)] : []),
  ]);
  return (updated?.results.length ?? 0) === 1;
}

const SEAL_SQL = {
  pass: `UPDATE passes SET download_token = ? WHERE id = ? AND download_token = ?
    AND NOT ${PASS_PENDING} AND NOT ${PASS_RESERVED} RETURNING id`,
  'apple-auth': `UPDATE passes SET auth_token = ? WHERE id = ? AND auth_token = ?
    AND NOT ${PASS_PENDING} AND NOT ${PASS_RESERVED} RETURNING id`,
  bundle: `UPDATE bundles SET token = ? WHERE id = ? AND token = ? AND NOT ${BUNDLE_RESERVED} RETURNING id`,
} as const;
