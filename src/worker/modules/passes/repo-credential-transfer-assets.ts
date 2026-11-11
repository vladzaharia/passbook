import type { Grant } from '../../platform/authority.ts';
import { writePart } from '../../platform/authority-include.ts';
import { passIs } from './credential-transfer-grant.ts';

const KEYS = `SELECT r2_key FROM pass_assets WHERE pass_id = ?
  UNION SELECT r2_key FROM member_photos WHERE pass_id = ?
  UNION SELECT r2_key FROM pass_transfer_asset_candidates WHERE pass_id = ?
  UNION SELECT r2_key FROM pass_transfer_asset_uploads WHERE pass_id = ? AND credential_generation < ?`;

/**
 * FINISH, after the completing update: the source credential's assets move to the GC queue and its
 * rows go, in the transfer's grant. The pass row the grant pinned (`row_version`) already proves the
 * asset and photo snapshot, since both move it.
 */
export function transferAssetRetirement(
  g: Grant,
  input: { transferId: string; passId: string; sourceGeneration: number; now: number },
): void {
  const { transferId, passId, sourceGeneration: gen, now } = input;
  const keys = [passId, passId, passId, passId, gen];
  const holder = g.principal.kind === 'holder';
  const source = holder ? '{pass}' : '?';
  g.include(
    writePart(
      `INSERT INTO pass_transfer_asset_gc (r2_key, transfer_id, source_pass_id, retired_at, next_attempt_at)
      SELECT keys.r2_key, ?, ${source}, ?, ? FROM (${KEYS}) keys
      WHERE {grant} AND EXISTS (SELECT 1 FROM passes p WHERE p.id = ? AND p.org_id = {org})
        AND NOT EXISTS (SELECT 1 FROM pass_transfer_asset_gc gc WHERE gc.r2_key = keys.r2_key)`,
      [transferId, ...(holder ? [] : [passId]), now, now, ...keys, passId],
    ),
    // Another pass may still hold one of these keys; wake its entry when the last reference is released (a
    // holder grant wakes only its own pass's entries).
    writePart(
      `UPDATE pass_transfer_asset_gc SET next_attempt_at = min(next_attempt_at, ?)
      WHERE {grant} ${holder ? 'AND source_pass_id = {pass}' : ''} AND r2_key IN (${KEYS})`,
      [now, ...keys],
    ),
  );
  g.joined('pass_assets', { via: 'pass_id', where: { pass_id: passId }, delete: true });
  g.delete('member_photos', { where: { pass_id: passId } });
  const at = passIs(g, passId);
  g.include(
    writePart(`DELETE FROM pass_transfer_asset_candidates WHERE ${at.sql} AND {grant}`, at.params),
    writePart(
      `DELETE FROM pass_transfer_asset_uploads WHERE ${at.sql} AND credential_generation < ? AND {grant}`,
      [...at.params, gen],
    ),
  );
}
