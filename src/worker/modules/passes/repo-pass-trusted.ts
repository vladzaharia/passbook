import {
  type IssuedToken,
  sealStatement,
  type TokenPurpose,
} from '../../platform/capability-token.ts';
import { batch, first, stmt } from '../../platform/db.ts';
import type { Pass } from './repo-map.ts';
import {
  REFRESH_BOUND_FENCE,
  REFRESH_UNBOUND_FENCE,
  type RefreshSnapshot,
  refreshFenceMismatch,
  refreshParams,
  refreshPredicate,
  validRefreshEpochs,
} from './repo-refresh-snapshot.ts';
import { BUNDLE_RESERVED, PASS_PENDING, PASS_RESERVED } from './repo-token-guards.ts';

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

const CLAIM_UNBOUND = `UPDATE passes SET refresh_requested_at = ?
     WHERE id = ? AND ${refreshPredicate} ${REFRESH_UNBOUND_FENCE}
       AND (refresh_requested_at IS NULL OR refresh_requested_at <= ?)
     RETURNING id`;

const CLAIM_BOUND = `UPDATE passes SET refresh_requested_at = ?
     WHERE id = ? AND ${refreshPredicate} ${REFRESH_BOUND_FENCE}
       AND (refresh_requested_at IS NULL OR refresh_requested_at <= ?)
     RETURNING id`;

/** Claims the slot only while the selected context  still match. */
export async function claimRefresh(
  db: D1Database,
  snapshot: RefreshSnapshot,
  now: number,
  windowMs: number,
): Promise<boolean> {
  if (!validRefreshEpochs(snapshot) || refreshFenceMismatch(snapshot)) return false;
  const row = await first<{ id: string }>(
    db,
    snapshot.connectionId === null ? CLAIM_UNBOUND : CLAIM_BOUND,
    [now, snapshot.passId, ...refreshParams(snapshot), now - windowMs],
  );
  return row !== null;
}

/**
 * Hides the pass from every list and lookup but the device protocol, and unlinks it from its
 * owner and connection. The retention job removes it later. Trusted callers only; tenants use the grant.
 * The owner leaves only behind an attach block (0055 trigger), written under the same fence.
 */
export async function softDeletePass(
  db: D1Database,
  pass: Pass,
  now: number,
  /** Retention: a legal hold on the pass or its org refuses the delete, decided in the same statement. */
  unlessHeld = false,
  /** Run in the same batch after the delete, so they commit or fail with it (a retention receipt). */
  extra: D1PreparedStatement[] = [],
): Promise<boolean> {
  const held = unlessHeld
    ? ` AND NOT EXISTS (SELECT 1 FROM retention_holds h WHERE h.released_at IS NULL
         AND h.org_id = passes.org_id AND (h.pass_id IS NULL OR h.pass_id = passes.id))`
    : '';
  const fence = `id = ? AND org_id = ? AND mode = ?
       AND template_id = ? AND template_version = ? AND serial = ? AND auth_token = ?
       AND holder_email IS ? AND owner_user_id IS ? AND version = ? AND link_generation = ?
       AND object_key = ? AND download_token = ? AND status = ? AND removed_at IS ?
       AND connection_id IS ? AND external_ref IS ? AND deleted_at IS NULL AND test_data_quarantined = 0${held}`;
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
    ...extra,
  ]);
  return (deleted?.results?.length ?? 0) === 1;
}

const REMAC_SQL = {
  pass: ['download', 'UPDATE passes SET download_token = ?'],
  'apple-auth': ['auth', 'UPDATE passes SET auth_token = ?'],
} as const;

/**
 * Replaces a stored MAC with the same token's MAC under the new root (cron tokens.remac), only while the
 * column still holds `from`. A pass or bundle writes the 0069 / 0087 mark first so the triggers let a MAC replace a MAC, and
 * removes it in the same batch. A pending transfer or a forwarding reservation refuses the row (false).
 */
export async function remacTrusted(
  db: D1Database,
  purpose: TokenPurpose,
  id: string,
  from: string,
  to: string,
): Promise<boolean> {
  if (purpose === 'join') {
    const [updated] = await batch(db, [
      stmt(db, 'UPDATE join_links SET token = ? WHERE id = ? AND token = ? RETURNING id', [
        to,
        id,
        from,
      ]),
    ]);
    return (updated?.results.length ?? 0) === 1;
  }
  if (purpose === 'bundle') {
    const [, updated] = await batch(db, [
      stmt(
        db,
        `INSERT INTO bundle_remac_marks (bundle_id, mac) VALUES (?, ?)
         ON CONFLICT (bundle_id) DO UPDATE SET mac = excluded.mac`,
        [id, to],
      ),
      stmt(
        db,
        `UPDATE bundles SET token = ? WHERE id = ? AND token = ? AND NOT ${BUNDLE_RESERVED} RETURNING id`,
        [to, id, from],
      ),
      stmt(db, 'DELETE FROM bundle_remac_marks WHERE bundle_id = ?', [id]),
    ]);
    return (updated?.results.length ?? 0) === 1;
  }
  const [kind, update] = REMAC_SQL[purpose];
  const column = kind === 'download' ? 'download_token' : 'auth_token';
  const [, updated] = await batch(db, [
    stmt(
      db,
      `INSERT INTO token_remac_marks (pass_id, kind, mac) VALUES (?, ?, ?)
       ON CONFLICT (pass_id, kind) DO UPDATE SET mac = excluded.mac`,
      [id, kind, to],
    ),
    stmt(
      db,
      `${update} WHERE id = ? AND ${column} = ? AND NOT ${PASS_PENDING} AND NOT ${PASS_RESERVED} RETURNING id`,
      [to, id, from],
    ),
    stmt(db, 'DELETE FROM token_remac_marks WHERE pass_id = ? AND kind = ?', [id, kind]),
  ]);
  return (updated?.results.length ?? 0) === 1;
}
