import { all, first, run } from '../../platform/db.ts';

/** A pending rewrite older than this is taken to have died with its isolate, and may be claimed again. */
const PENDING_MS = 300_000;

/** Records a class as written by a release, with the body Google was given. Never moves a class backwards. */
export async function recordGoogleClass(
  db: D1Database,
  p: {
    classIdHash: string;
    releaseId: string;
    releaseGeneration: number;
    bodyDigest: string;
    now: number;
  },
): Promise<void> {
  await run(
    db,
    `INSERT INTO wallet_google_classes (class_id_hash, release_id, release_generation, body_digest, written_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT (class_id_hash) DO UPDATE SET
      release_id = excluded.release_id, release_generation = excluded.release_generation,
      body_digest = excluded.body_digest, pending_generation = NULL, pending_at = NULL,
      written_at = excluded.written_at
    WHERE excluded.release_generation >= wallet_google_classes.release_generation`,
    [p.classIdHash, p.releaseId, p.releaseGeneration, p.bodyDigest, p.now],
  );
}

/**
 * Compare-and-set before a rewrite: true for exactly one caller. It wins for a newer release than the row
 * (or one already pending for), or for the same release when Google no longer holds the body recorded for
 * it (a rewrite that was lost). A class with no row is recorded as generation 0 first.
 */
export async function claimGoogleClassRewrite(
  db: D1Database,
  p: {
    classIdHash: string;
    releaseId: string;
    releaseGeneration: number;
    bodyDigest: string;
    now: number;
  },
): Promise<boolean> {
  await run(
    db,
    `INSERT INTO wallet_google_classes (class_id_hash, release_id, release_generation, written_at)
    VALUES (?, ?, 0, ?) ON CONFLICT (class_id_hash) DO NOTHING`,
    [p.classIdHash, p.releaseId, p.now],
  );
  const row = await first(
    db,
    `UPDATE wallet_google_classes SET pending_generation = ?, pending_at = ?
    WHERE class_id_hash = ? AND (pending_generation IS NULL OR pending_at < ?)
      AND (release_generation < ? OR (release_generation = ? AND body_digest = ?))
    RETURNING 1 AS won`,
    [
      p.releaseGeneration,
      p.now,
      p.classIdHash,
      p.now - PENDING_MS,
      p.releaseGeneration,
      p.releaseGeneration,
      p.bodyDigest,
    ],
  );
  return row !== null;
}

/** A rewrite that did not land frees the class for the next operation. */
export async function releaseGoogleClassRewrite(
  db: D1Database,
  classIdHash: string,
  releaseGeneration: number,
): Promise<void> {
  await run(
    db,
    `UPDATE wallet_google_classes SET pending_generation = NULL, pending_at = NULL
    WHERE class_id_hash = ? AND pending_generation = ?`,
    [classIdHash, releaseGeneration],
  );
}

export type GoogleClassReview = 'DRAFT' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED';

/** What was last read of the class's review and when; a class with no row is not recorded here. */
export async function getGoogleClassReview(
  db: D1Database,
  classIdHash: string,
): Promise<{ status: GoogleClassReview | null; checkedAt: number | null } | null> {
  return first(
    db,
    `SELECT review_status AS status, review_checked_at AS checkedAt
    FROM wallet_google_classes WHERE class_id_hash = ?`,
    [classIdHash],
  );
}

export async function setGoogleClassReview(
  db: D1Database,
  classIdHash: string,
  status: GoogleClassReview | null,
  now: number,
): Promise<void> {
  await run(
    db,
    `UPDATE wallet_google_classes SET review_status = ?, review_checked_at = ? WHERE class_id_hash = ?`,
    [status, now, classIdHash],
  );
}

/** True when a class this release wrote is rejected by Google: the release offers nothing. */
export async function googleReleaseRejected(db: D1Database, releaseId: string): Promise<boolean> {
  return (
    (await first(
      db,
      `SELECT 1 FROM wallet_google_classes WHERE release_id = ? AND review_status = 'REJECTED' LIMIT 1`,
      [releaseId],
    )) !== null
  );
}

/** The worst review among the classes each release wrote: rejected, then waiting, else approved. */
export async function googleReleaseReviews(
  db: D1Database,
  releaseIds: readonly string[],
): Promise<Map<string, 'waiting' | 'rejected' | 'approved'>> {
  const out = new Map<string, 'waiting' | 'rejected' | 'approved'>();
  if (releaseIds.length === 0) return out;
  const rows = await all<{ releaseId: string; rejected: number; waiting: number }>(
    db,
    `SELECT release_id AS releaseId,
      MAX(review_status = 'REJECTED') AS rejected,
      MAX(review_status IS NULL OR review_status IN ('DRAFT', 'UNDER_REVIEW')) AS waiting
    FROM wallet_google_classes WHERE release_id IN (${releaseIds.map(() => '?').join(',')})
    GROUP BY release_id`,
    [...releaseIds],
  );
  for (const r of rows)
    out.set(r.releaseId, r.rejected ? 'rejected' : r.waiting ? 'waiting' : 'approved');
  return out;
}

/** Whether this release recorded exactly this body for the class since `since` (a recent write of it). */
export async function googleClassWrittenSince(
  db: D1Database,
  p: { classIdHash: string; releaseId: string; releaseGeneration: number; bodyDigest: string },
  since: number,
): Promise<boolean> {
  return (
    (await first(
      db,
      `SELECT 1 FROM wallet_google_classes WHERE class_id_hash = ? AND release_id = ?
        AND release_generation = ? AND body_digest = ? AND pending_generation IS NULL AND written_at >= ?`,
      [p.classIdHash, p.releaseId, p.releaseGeneration, p.bodyDigest, since],
    )) !== null
  );
}
