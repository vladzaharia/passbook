import { all, chunk, first, placeholders, run } from '../../platform/db.ts';

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
    /** Set only when Google itself was asked (created, compared, rewritten); a cache hit leaves it. */
    verifiedAt?: number;
  },
): Promise<void> {
  // A moved body or generation is a new review: the old status is cleared with it.
  const same = `wallet_google_classes.body_digest IS excluded.body_digest
    AND wallet_google_classes.release_generation = excluded.release_generation`;
  await run(
    db,
    `INSERT INTO wallet_google_classes (class_id_hash, release_id, release_generation, body_digest, written_at, verified_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (class_id_hash) DO UPDATE SET
      release_id = excluded.release_id, release_generation = excluded.release_generation,
      body_digest = excluded.body_digest, pending_generation = NULL, pending_at = NULL,
      written_at = excluded.written_at,
      review_status = CASE WHEN ${same} THEN wallet_google_classes.review_status END,
      review_checked_at = CASE WHEN ${same} THEN wallet_google_classes.review_checked_at END,
      verified_at = CASE WHEN excluded.verified_at IS NOT NULL THEN excluded.verified_at
        WHEN ${same} THEN wallet_google_classes.verified_at END
    WHERE excluded.release_generation >= wallet_google_classes.release_generation`,
    [p.classIdHash, p.releaseId, p.releaseGeneration, p.bodyDigest, p.now, p.verifiedAt ?? null],
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
type ReviewSummary = 'waiting' | 'rejected' | 'approved';

/** The class as last written, for a review read to fence its result on. */
export async function getGoogleClassState(
  db: D1Database,
  classIdHash: string,
): Promise<{
  releaseGeneration: number;
  bodyDigest: string | null;
  status: GoogleClassReview | null;
} | null> {
  return first(
    db,
    `SELECT release_generation AS releaseGeneration, body_digest AS bodyDigest, review_status AS status
    FROM wallet_google_classes WHERE class_id_hash = ?`,
    [classIdHash],
  );
}

/**
 * Compare-and-set before a review read: true for exactly one caller per `since` window, so a bulk run sends
 * one GET and an APPROVED class is never read again. Stamps the attempt, so a failing read waits too.
 */
export async function claimGoogleClassReview(
  db: D1Database,
  classIdHash: string,
  now: number,
  since: number,
): Promise<boolean> {
  return (
    (await first(
      db,
      `UPDATE wallet_google_classes SET review_checked_at = ?
      WHERE class_id_hash = ? AND (review_status IS NULL OR review_status != 'APPROVED')
        AND pending_generation IS NULL AND (review_checked_at IS NULL OR review_checked_at < ?)
      RETURNING 1 AS won`,
      [now, classIdHash, since],
    )) !== null
  );
}

/** Stores what Google said, only if the class is still the one it was read for (same body and generation). */
export async function setGoogleClassReview(
  db: D1Database,
  p: { classIdHash: string; releaseGeneration: number; bodyDigest: string | null },
  status: GoogleClassReview | null,
): Promise<void> {
  await run(
    db,
    `UPDATE wallet_google_classes SET review_status = ?
    WHERE class_id_hash = ? AND release_generation = ? AND body_digest IS ? AND pending_generation IS NULL`,
    [status, p.classIdHash, p.releaseGeneration, p.bodyDigest],
  );
}

/** True when a Google class one of the pass's instances was issued under is rejected: it offers nothing. */
export async function googlePassClassRejected(db: D1Database, passId: string): Promise<boolean> {
  return (
    (await first(
      db,
      `SELECT 1 FROM wallet_provider_instances i
      JOIN wallet_google_callback_bindings b ON b.instance_id = i.id
      JOIN wallet_google_classes c ON c.class_id_hash = b.class_id_hash
      WHERE i.pass_id = ? AND i.provider = 'google' AND i.retirement_requested_at IS NULL
        AND c.review_status = 'REJECTED' LIMIT 1`,
      [passId],
    )) !== null
  );
}

/** The worst review among the classes each release wrote: rejected, then waiting, else approved. */
export async function googleReleaseReviews(
  db: D1Database,
  releaseIds: readonly string[],
): Promise<Map<string, ReviewSummary>> {
  const out = new Map<string, ReviewSummary>();
  for (const ids of chunk([...new Set(releaseIds)])) {
    const rows = await all<{ releaseId: string; rejected: number; waiting: number }>(
      db,
      `SELECT release_id AS releaseId,
        MAX(review_status = 'REJECTED') AS rejected,
        MAX(review_status IS NULL OR review_status IN ('DRAFT', 'UNDER_REVIEW')) AS waiting
      FROM wallet_google_classes WHERE release_id IN (${placeholders(ids.length)})
      GROUP BY release_id`,
      ids,
    );
    for (const r of rows)
      out.set(r.releaseId, r.rejected ? 'rejected' : r.waiting ? 'waiting' : 'approved');
  }
  return out;
}

/** Whether Google itself confirmed exactly this body for the class, for this release, since `since`. */
export async function googleClassVerifiedSince(
  db: D1Database,
  p: { classIdHash: string; releaseId: string; releaseGeneration: number; bodyDigest: string },
  since: number,
): Promise<boolean> {
  return (
    (await first(
      db,
      `SELECT 1 FROM wallet_google_classes WHERE class_id_hash = ? AND release_id = ?
        AND release_generation = ? AND body_digest = ? AND pending_generation IS NULL AND verified_at >= ?`,
      [p.classIdHash, p.releaseId, p.releaseGeneration, p.bodyDigest, since],
    )) !== null
  );
}
