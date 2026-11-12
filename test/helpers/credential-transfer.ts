import { batch, stmt } from '../../src/worker/platform/db.ts';

/** Reserve a transfer for isolated database guard tests, without running the transfer service. */
export async function stagePendingCredentialTransfer(
  db: D1Database,
  passId: string,
  options: {
    id: string;
    token: string;
    now: number;
    targetHolderEmail?: string | null;
    targetOwnerUserId?: string | null;
  },
): Promise<void> {
  // Force a rollback if either statement did not match exactly one row.
  const guard = () =>
    stmt(
      db,
      `SELECT CASE WHEN changes() = 1 THEN NULL ELSE json_extract('[0]', '$[__transfer_fixture_lost__]') END`,
    );
  await batch(db, [
    stmt(
      db,
      `INSERT INTO pass_credential_transfers
      (id, pass_id, org_id, mode, state, source_generation, source_version, source_revision, source_row_version,
       source_lifecycle_generation, source_link_generation, target_holder_email, target_owner_user_id,
       requested_by_type, requested_by_id, requested_at)
      SELECT ?, p.id, p.org_id, p.mode, 'pending', p.credential_generation, p.version, p.revision, p.row_version,
        p.lifecycle_generation, p.link_generation + 1, ?, ?, 'system', NULL, ?
      FROM passes p WHERE p.id = ?`,
      [
        options.id,
        options.targetHolderEmail ?? null,
        options.targetOwnerUserId ?? null,
        options.now,
        passId,
      ],
    ),
    guard(),
    stmt(
      db,
      `UPDATE passes AS p SET credential_generation = credential_generation + 1,
      link_generation = link_generation + 1, download_token = ?, download_token_rotated_at = ?
      WHERE p.id = ? AND EXISTS (SELECT 1 FROM pass_credential_transfers t
        WHERE t.id = ? AND t.pass_id = p.id AND t.org_id = p.org_id AND t.mode = p.mode
          AND t.state = 'pending' AND t.source_generation = p.credential_generation
          AND t.source_row_version = p.row_version
          AND t.source_lifecycle_generation = p.lifecycle_generation
          AND t.source_link_generation = p.link_generation + 1)`,
      [options.token, options.now, passId, options.id],
    ),
    guard(),
  ]);
}
