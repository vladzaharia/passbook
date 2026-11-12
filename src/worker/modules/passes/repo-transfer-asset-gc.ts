import { all, batch, first, run, stmt } from '../../platform/db.ts';
import { unreferencedPassAssetKeySql } from './repo-pass-asset-references.ts';

/**
 * Resolve only this operation's rollback hold and/or upload reservation. A genuinely detached
 * key is permanently queued even while shared records still reference it; claims wait until all
 * such references and holds disappear. The result proves that the specified hold was released.
 */
export async function retireUnusedPassAssetKey(
  db: D1Database,
  input: {
    key: string;
    now: number;
    passId?: string;
    candidateId?: number;
  },
): Promise<boolean> {
  if (input.candidateId !== undefined && input.passId === undefined)
    throw new Error('A candidate must be resolved by its pass.');
  const results = await batch(db, [
    ...(input.candidateId === undefined
      ? []
      : [
          stmt(
            db,
            `INSERT INTO pass_transfer_asset_gc
        (r2_key,transfer_id,source_pass_id,retired_at,next_attempt_at)
        SELECT c.r2_key,NULL,NULL,?1,?1 FROM pass_transfer_asset_candidates c
        WHERE c.id = ?2 AND c.pass_id = ?3 AND c.r2_key = ?4
          AND (c.next_row IS NULL OR json_extract(c.next_row,'$[2]') IS NOT c.r2_key)
          AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = c.pass_id AND t.state = 'pending')
          AND NOT EXISTS (SELECT 1 FROM pass_transfer_asset_gc gc WHERE gc.r2_key = c.r2_key)`,
            [input.now, input.candidateId, input.passId, input.key],
          ),
          stmt(
            db,
            `DELETE FROM pass_transfer_asset_candidates
        WHERE id = ? AND pass_id = ? AND r2_key = ?
          AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
            WHERE t.pass_id = pass_transfer_asset_candidates.pass_id AND t.state = 'pending')`,
            [input.candidateId, input.passId, input.key],
          ),
        ]),
    ...(input.passId === undefined
      ? []
      : [
          stmt(
            db,
            `INSERT INTO pass_transfer_asset_gc
        (r2_key,transfer_id,source_pass_id,retired_at,next_attempt_at)
        SELECT u.r2_key,NULL,NULL,?1,?1 FROM pass_transfer_asset_uploads u
        WHERE u.pass_id = ?2 AND u.r2_key = ?3
          AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = u.pass_id AND t.state = 'pending')
          AND NOT EXISTS (SELECT 1 FROM pass_transfer_asset_gc gc WHERE gc.r2_key = u.r2_key)`,
            [input.now, input.passId, input.key],
          ),
          stmt(
            db,
            `DELETE FROM pass_transfer_asset_uploads WHERE pass_id = ? AND r2_key = ?
        AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
          WHERE t.pass_id = pass_transfer_asset_uploads.pass_id AND t.state = 'pending')`,
            [input.passId, input.key],
          ),
        ]),
    stmt(
      db,
      `INSERT INTO pass_transfer_asset_gc
      (r2_key,transfer_id,source_pass_id,retired_at,next_attempt_at)
      SELECT ?1,NULL,NULL,?2,?2 WHERE NOT EXISTS
        (SELECT 1 FROM pass_transfer_asset_gc gc WHERE gc.r2_key = ?1) AND ${unreferencedPassAssetKeySql('?1')}`,
      [input.key, input.now],
    ),
    stmt(
      db,
      `UPDATE pass_transfer_asset_gc SET next_attempt_at = min(next_attempt_at, ?2) WHERE r2_key = ?1`,
      [input.key, input.now],
    ),
  ]);
  return input.candidateId === undefined || (results[1]?.meta.changes ?? 0) === 1;
}

/** Recover at most the newest unfinished image operation per pass, in reverse staging order. */
export function listExpiredPassAssetCandidates(db: D1Database, cutoff: number, limit: number) {
  return all<{ id: number; created_at: number }>(
    db,
    `SELECT c.id, c.created_at
    FROM pass_transfer_asset_candidates c WHERE c.created_at <= ?
      AND NOT EXISTS (SELECT 1 FROM pass_transfer_asset_candidates newer
        WHERE newer.pass_id = c.pass_id AND newer.id > c.id)
      AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
        WHERE t.pass_id = c.pass_id AND t.state = 'pending')
    ORDER BY c.created_at, c.id LIMIT ?`,
    [cutoff, limit],
  );
}

/**
 * An abandoned stage is undone only if the exact staged row and pass incarnation/version still
 * match. The recovery marker captures the current image epoch in the same transaction; restoring
 * the row advances it, fencing any artifact a late writer built from the abandoned stage.
 * The displaced key is durably queued even when another record shares it; a claim still requires
 * no references or holds. A pending transfer owns its holds until its final CAS.
 */
export async function recoverExpiredPassAssetCandidate(
  db: D1Database,
  input: {
    id: number;
    createdAt: number;
    cutoff: number;
    now: number;
  },
): Promise<void> {
  const source = `c.id = ?1 AND p.id = c.pass_id
    AND p.credential_generation = c.source_credential_generation
    AND p.lifecycle_generation = c.source_lifecycle_generation
    AND p.version = c.source_version AND p.revision = c.source_revision
    AND p.image_generation = r.image_generation AND p.link_generation = r.link_generation
    AND p.image_generation >= c.source_image_generation`;
  const prior = (index: number) => `json_extract(c.prior_row, '$[${index}]')`;
  const assetRow =
    'json_array(a.pass_id,a.name,a.r2_key,a.sha1,a.size,a.width,a.height,a.crc32,a.created_at)';
  const photoRow =
    'json_array(m.pass_id,m.org_id,m.r2_key,m.sha1,m.size,m.crc32,m.include_in_pass,m.version,m.updated_at)';
  await batch(db, [
    stmt(
      db,
      `INSERT INTO pass_transfer_asset_recoveries
      (candidate_id,pass_id,kind,slot,prior_key,next_key,image_generation,link_generation)
      SELECT c.id,c.pass_id,c.kind,c.slot,c.r2_key,json_extract(c.next_row,'$[2]'),p.image_generation,p.link_generation
      FROM pass_transfer_asset_candidates c JOIN passes p ON p.id = c.pass_id
      WHERE c.id = ?1 AND c.created_at = ?2 AND c.created_at <= ?3
        AND NOT EXISTS (SELECT 1 FROM pass_transfer_asset_candidates newer
          WHERE newer.pass_id = c.pass_id AND newer.id > c.id)
        AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
          WHERE t.pass_id = c.pass_id AND t.state = 'pending')`,
      [input.id, input.createdAt, input.cutoff],
    ),
    stmt(
      db,
      `UPDATE pass_assets AS a SET (r2_key,sha1,size,width,height,crc32,created_at) =
      (SELECT ${prior(2)},${prior(3)},${prior(4)},${prior(5)},${prior(6)},${prior(7)},${prior(8)}
       FROM pass_transfer_asset_candidates c WHERE c.id = ?1)
      WHERE EXISTS (SELECT 1 FROM pass_transfer_asset_candidates c
        JOIN pass_transfer_asset_recoveries r ON r.candidate_id = c.id JOIN passes p ON p.id = c.pass_id
        WHERE ${source} AND c.kind = 'asset' AND c.next_row IS NOT NULL
          AND a.pass_id = c.pass_id AND a.name = c.slot AND ${assetRow} = c.next_row)`,
      [input.id],
    ),
    stmt(
      db,
      'UPDATE pass_transfer_asset_recoveries SET restored = 1 WHERE candidate_id = ? AND changes() = 1',
      [input.id],
    ),
    stmt(
      db,
      `INSERT INTO pass_assets(pass_id,name,r2_key,sha1,size,width,height,crc32,created_at)
      SELECT ${prior(0)},${prior(1)},${prior(2)},${prior(3)},${prior(4)},${prior(5)},
        ${prior(6)},${prior(7)},${prior(8)}
      FROM pass_transfer_asset_candidates c
      JOIN pass_transfer_asset_recoveries r ON r.candidate_id = c.id JOIN passes p ON p.id = c.pass_id
      WHERE ${source} AND c.kind = 'asset' AND c.next_row IS NULL
        AND NOT EXISTS (SELECT 1 FROM pass_assets a WHERE a.pass_id = c.pass_id AND a.name = c.slot)`,
      [input.id],
    ),
    stmt(
      db,
      'UPDATE pass_transfer_asset_recoveries SET restored = 1 WHERE candidate_id = ? AND changes() = 1',
      [input.id],
    ),
    stmt(
      db,
      `UPDATE member_photos AS m SET (org_id,r2_key,sha1,size,crc32,include_in_pass,version,updated_at) =
      (SELECT ${prior(1)},${prior(2)},${prior(3)},${prior(4)},${prior(5)},${prior(6)},${prior(7)},${prior(8)}
       FROM pass_transfer_asset_candidates c WHERE c.id = ?1)
      WHERE EXISTS (SELECT 1 FROM pass_transfer_asset_candidates c
        JOIN pass_transfer_asset_recoveries r ON r.candidate_id = c.id JOIN passes p ON p.id = c.pass_id
        WHERE ${source} AND c.kind = 'photo' AND c.next_row IS NOT NULL
          AND m.pass_id = c.pass_id AND ${photoRow} = c.next_row)`,
      [input.id],
    ),
    stmt(
      db,
      'UPDATE pass_transfer_asset_recoveries SET restored = 1 WHERE candidate_id = ? AND changes() = 1',
      [input.id],
    ),
    stmt(
      db,
      `INSERT INTO member_photos(pass_id,org_id,r2_key,sha1,size,crc32,include_in_pass,version,updated_at)
      SELECT ${prior(0)},${prior(1)},${prior(2)},${prior(3)},${prior(4)},${prior(5)},
        ${prior(6)},${prior(7)},${prior(8)}
      FROM pass_transfer_asset_candidates c
      JOIN pass_transfer_asset_recoveries r ON r.candidate_id = c.id JOIN passes p ON p.id = c.pass_id
      WHERE ${source} AND c.kind = 'photo' AND c.next_row IS NULL
        AND NOT EXISTS (SELECT 1 FROM member_photos m WHERE m.pass_id = c.pass_id)`,
      [input.id],
    ),
    stmt(
      db,
      'UPDATE pass_transfer_asset_recoveries SET restored = 1 WHERE candidate_id = ? AND changes() = 1',
      [input.id],
    ),
    // Recovery itself is an image mutation and must invalidate scanner/public-link snapshots,
    // just like the ordinary writer's compensation batch.
    stmt(
      db,
      `UPDATE passes SET link_generation = link_generation + 1
      WHERE id = (SELECT pass_id FROM pass_transfer_asset_recoveries WHERE candidate_id = ?1)
        AND image_generation = (SELECT image_generation + 1 FROM pass_transfer_asset_recoveries WHERE candidate_id = ?1)
        AND link_generation = (SELECT link_generation FROM pass_transfer_asset_recoveries WHERE candidate_id = ?1)`,
      [input.id],
    ),
    stmt(
      db,
      `DELETE FROM pass_transfer_asset_candidates WHERE id = ?1
      AND EXISTS (SELECT 1 FROM pass_transfer_asset_recoveries r WHERE r.candidate_id = ?1)`,
      [input.id],
    ),
    stmt(
      db,
      `INSERT INTO pass_transfer_asset_gc
      (r2_key,transfer_id,source_pass_id,retired_at,next_attempt_at)
      SELECT keys.r2_key,NULL,NULL,?2,?2 FROM (
        SELECT CASE WHEN restored = 1 THEN next_key ELSE prior_key END AS r2_key
        FROM pass_transfer_asset_recoveries WHERE candidate_id = ?1
          AND (next_key IS NULL OR next_key IS NOT prior_key)
      ) keys WHERE keys.r2_key IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pass_transfer_asset_gc gc WHERE gc.r2_key = keys.r2_key)`,
      [input.id, input.now],
    ),
    stmt(
      db,
      `UPDATE pass_transfer_asset_gc AS gc SET next_attempt_at = min(next_attempt_at, ?2)
      WHERE gc.r2_key = (SELECT CASE WHEN restored = 1 THEN next_key ELSE prior_key END
        FROM pass_transfer_asset_recoveries WHERE candidate_id = ?1
          AND (next_key IS NULL OR next_key IS NOT prior_key))`,
      [input.id, input.now],
    ),
    stmt(db, 'DELETE FROM pass_transfer_asset_recoveries WHERE candidate_id = ?', [input.id]),
  ]);
}

/** The due query excludes shared/foreign keys before LIMIT, so they cannot starve the queue. */
export function listDueRetiredPassAssetKeys(
  db: D1Database,
  now: number,
  limit: number,
): Promise<{ r2_key: string }[]> {
  return all(
    db,
    `SELECT gc.r2_key FROM pass_transfer_asset_gc gc
    WHERE gc.deletion_eligible = 1 AND gc.settled_at IS NULL AND gc.next_attempt_at <= ?
      AND (gc.claim_until IS NULL OR gc.claim_until <= ?) AND ${unreferencedPassAssetKeySql('gc.r2_key')}
    ORDER BY gc.next_attempt_at, gc.r2_key LIMIT ?`,
    [now, now, limit],
  );
}

export async function claimRetiredPassAssetKey(
  db: D1Database,
  input: {
    key: string;
    token: string;
    now: number;
    until: number;
  },
): Promise<boolean> {
  return (
    (await first(
      db,
      `UPDATE pass_transfer_asset_gc AS gc
    SET claim_token = ?1, claim_until = ?2, attempts = attempts + 1
    WHERE gc.r2_key = ?3 AND gc.deletion_eligible = 1 AND gc.settled_at IS NULL AND gc.next_attempt_at <= ?4
      AND (gc.claim_until IS NULL OR gc.claim_until <= ?4) AND ${unreferencedPassAssetKeySql('gc.r2_key')}
    RETURNING r2_key`,
      [input.token, input.until, input.key, input.now],
    )) !== null
  );
}

/**
 * Leave the tombstone due again for `maxRechecks` more looks, since an old in-flight PUT may arrive even after
 * deletion; after that it settles and the sweep stops visiting it.
 */
export async function acknowledgeRetiredPassAssetKey(
  db: D1Database,
  input: {
    key: string;
    token: string;
    now: number;
    nextAttemptAt: number;
    maxRechecks: number;
  },
): Promise<void> {
  await run(
    db,
    `UPDATE pass_transfer_asset_gc AS gc
    SET claim_token = NULL, claim_until = NULL, attempts = 0,
      last_deleted_at = ?1, next_attempt_at = ?2, rechecks = rechecks + 1,
      settled_at = CASE WHEN rechecks + 1 >= ?5 THEN ?1 ELSE NULL END
    WHERE gc.r2_key = ?3 AND gc.claim_token = ?4 AND gc.claim_until > ?1
      AND ${unreferencedPassAssetKeySql('gc.r2_key')}`,
    [input.now, input.nextAttemptAt, input.key, input.token, input.maxRechecks],
  );
}

/** An uncertain R2 response is retried; an uncertain D1 response leaves the lease to expire. */
export async function deferRetiredPassAssetKey(
  db: D1Database,
  input: {
    key: string;
    token: string;
    now: number;
    nextAttemptAt: number;
  },
): Promise<void> {
  await run(
    db,
    `UPDATE pass_transfer_asset_gc
    SET claim_token = NULL, claim_until = NULL, next_attempt_at = ?
    WHERE r2_key = ? AND claim_token = ? AND claim_until > ?`,
    [input.nextAttemptAt, input.key, input.token, input.now],
  );
}
