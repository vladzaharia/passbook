import { first, run } from '../../platform/db.ts';

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
