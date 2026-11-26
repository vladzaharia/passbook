import type { GoogleType } from '../../../passkit/wallets/google/types.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { canonicalJson } from '../templates/package/hash.ts';
import type { GoogleClassScope } from './google-ids.ts';
import { type DerivedGoogleId, googleClassId } from './google-ids.ts';
import type { GoogleGenericProjection } from './google-projection.ts';
import { GOOGLE_RESOURCES, type GoogleWalletRestContext, verifyIdentity } from './google-rest.ts';
import { rewriteGoogleClass, upsertGoogleClass } from './google-rest-typed.ts';
import type { GoogleClassWrite } from './repo-google-class.ts';
import {
  claimGoogleClassRewrite,
  type GoogleClassReview,
  getGoogleClassReview,
  googleClassWrittenSince,
  recordGoogleClass,
  releaseGoogleClassRewrite,
  setGoogleClassReview,
} from './repo-google-class-write.ts';

/** A class still under review is read again no sooner than this after the last read. */
const REVIEW_RECHECK_MS = 60_000;
/** A class its release wrote this recently is not sent or compared again. */
const CLASS_FRESH_MS = 600_000;
const REVIEWS: readonly string[] = ['DRAFT', 'UNDER_REVIEW', 'APPROVED', 'REJECTED'];

/**
 * Reads Google's review of the class back and stores it: after a write (`fresh`), and on later operations
 * until it is approved. Google writes a class UNDER_REVIEW and never says when it changes.
 */
async function readClassReview(
  rest: GoogleWalletRestContext,
  db: D1Database,
  now: number,
  type: GoogleType,
  classId: DerivedGoogleId,
  classIdHash: string,
  fresh: boolean,
): Promise<void> {
  if (!fresh) {
    const held = await getGoogleClassReview(db, classIdHash);
    if (held?.status === 'APPROVED') return;
    if (held?.checkedAt != null && now - held.checkedAt < REVIEW_RECHECK_MS) return;
  }
  const read = await verifyIdentity(rest, GOOGLE_RESOURCES[type].class, classId);
  const status = typeof read.reviewStatus === 'string' ? read.reviewStatus.toUpperCase() : null;
  await setGoogleClassReview(
    db,
    classIdHash,
    REVIEWS.includes(status ?? '') ? (status as GoogleClassReview) : null,
    now,
  );
}

/**
 * A class is written once per release. The release that last wrote it is recorded; a newer release of the
 * template that compiles a different class body (a new event name, venue, date or logo) rewrites it once,
 * so existing holders follow the template and Google reviews it again (Q16, accepted). Exactly one operation
 * sends the rewrite (a compare-and-set on the class row); one that loses leaves it to the winner. The same
 * release never rewrites a class, except to restore the body it recorded when Google lost it: two passes of
 * one release compiling different bodies is `drift`, and the class stays.
 */
export async function upsertClassForRelease(
  rest: GoogleWalletRestContext,
  db: D1Database,
  now: number,
  type: GoogleType,
  scope: GoogleClassScope,
  body: GoogleGenericProjection,
  writer: GoogleClassWrite,
): Promise<'ok' | 'rewritten' | 'drift'> {
  const bodyDigest = await sha256Hex(canonicalJson(body));
  // The first tap has a time budget: a class this release wrote a moment ago costs no provider call.
  const known = await googleClassId(rest.account.issuerId, rest.objectIdHmacKey, {
    ...scope,
    type,
  });
  const knownHash = await sha256Hex(known);
  if (
    await googleClassWrittenSince(
      db,
      {
        classIdHash: knownHash,
        releaseId: writer.releaseId,
        releaseGeneration: writer.releaseGeneration,
        bodyDigest,
      },
      now - CLASS_FRESH_MS,
    )
  ) {
    await readClassReview(rest, db, now, type, known, knownHash, false);
    return 'ok';
  }
  const { result, classId } = await upsertGoogleClass(rest, type, scope, body);
  const classIdHash = await sha256Hex(classId);
  const mine = { ...writer, classIdHash, bodyDigest, now };
  if (result === 'created' || result === 'unchanged') {
    await recordGoogleClass(db, mine);
    await readClassReview(rest, db, now, type, classId, classIdHash, result === 'created');
    return 'ok';
  }
  if (!(await claimGoogleClassRewrite(db, mine))) {
    // Someone else holds the rewrite (a newer release already sent), or the class is this release's: drift.
    return 'drift';
  }
  try {
    await rewriteGoogleClass(rest, type, classId, body);
  } catch (error) {
    await releaseGoogleClassRewrite(db, classIdHash, writer.releaseGeneration);
    throw error;
  }
  await recordGoogleClass(db, mine);
  await readClassReview(rest, db, now, type, classId, classIdHash, true);
  return 'rewritten';
}
