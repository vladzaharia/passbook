import { all, batch, first, stmt } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

/** Return the pass's actual release binding for a simulated mutation result. */
export async function passRelease(ctx: ServiceContext, passId: string) {
  const pass = await first<{
    template_id: string;
    template_version: string;
    release_id: string | null;
  }>(ctx.env.DB, 'SELECT template_id, template_version, release_id FROM passes WHERE id = ?', [
    passId,
  ]);
  if (!pass) throw new Error(`Missing pass ${passId}`);
  return {
    templateId: pass.template_id,
    templateVersion: pass.template_version,
    releaseId: pass.release_id,
  };
}

/** Reserve a real transfer in D1, including the credential rotation performed at start. */
export async function startPendingTransfer(ctx: ServiceContext, passId: string) {
  const db = ctx.env.DB;
  await batch(db, [
    stmt(
      db,
      `INSERT INTO pass_credential_transfers
      (id, pass_id, org_id, mode, state, source_generation, source_version, source_revision, source_row_version,
       source_lifecycle_generation, source_link_generation, target_holder_email, target_owner_user_id,
       requested_by_type, requested_by_id, requested_at, completed_at)
      SELECT ?, id, org_id, mode, 'pending', credential_generation, version, revision, row_version,
       lifecycle_generation, link_generation + 1, ?, NULL, 'system', NULL, ?, NULL FROM passes WHERE id = ?`,
      [ctx.ids.id(), 'new@example.test', ctx.clock.now(), passId],
    ),
    stmt(
      db,
      `UPDATE passes SET credential_generation = credential_generation + 1,
      download_token = ?, link_generation = link_generation + 1 WHERE id = ?`,
      [ctx.ids.token(), passId],
    ),
  ]);
}

/** Simulate corrupted singleton state atomically, restoring the immutable schema guards. */
export async function replaceKeysetForTest(ctx: ServiceContext, commitment: string | null) {
  const db = ctx.env.DB;
  const guards = await all<{ name: string; sql: string | null }>(
    db,
    `SELECT name, sql FROM sqlite_master
         WHERE type = 'trigger' AND tbl_name = 'credential_ref_keyset' ORDER BY name`,
  );
  if (
    !guards.length ||
    guards.some((guard) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(guard.name) || !guard.sql)
  ) {
    throw new Error('Missing credential keyset immutability guards');
  }
  await batch(db, [
    ...guards.map((guard) => stmt(db, `DROP TRIGGER "${guard.name}"`)),
    commitment === null
      ? stmt(db, 'DELETE FROM credential_ref_keyset WHERE id = 1')
      : stmt(
          db,
          `INSERT INTO credential_ref_keyset (id, commitment) VALUES (1, ?)
          ON CONFLICT(id) DO UPDATE SET commitment = excluded.commitment`,
          [commitment],
        ),
    ...guards.map((guard) => stmt(db, guard.sql as string)),
  ]);
}
