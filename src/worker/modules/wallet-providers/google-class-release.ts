import type { GoogleType } from '../../../passkit/wallets/google/types.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { canonicalJson } from '../templates/package/hash.ts';
import { type GoogleClassScope, googleClassId } from './google-ids.ts';
import type { GoogleGenericProjection } from './google-projection.ts';
import type { GoogleWalletRestContext } from './google-rest.ts';
import { rewriteGoogleClass, upsertGoogleClass } from './google-rest-typed.ts';
import type { GoogleClassWrite } from './repo-google-class.ts';
import {
  claimGoogleClassRewrite,
  googleClassVerifiedSince,
  recordGoogleClass,
  releaseGoogleClassRewrite,
} from './repo-google-class-write.ts';

/** A class its release wrote, or Google confirmed, this recently is not sent or compared again. */
const CLASS_FRESH_MS = 600_000;

/**
 * A class is written once per release. The release that last wrote it is recorded; a newer release of the
 * template that compiles a different class body (a new event name, venue, date or logo) rewrites it once,
 * so existing holders follow the template and Google reviews it again (Q16, accepted). Exactly one operation
 * sends the rewrite (a compare-and-set on the class row); one that loses leaves it to the winner. The same
 * release never rewrites a class, except to restore the body it recorded when Google lost it: two passes of
 * one release compiling different bodies is `drift`, and the class stays. Google's review of the class is
 * read separately (`google-class-review.ts`), never on this path.
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
  // The first tap has a time budget: a class Google confirmed a moment ago costs no provider call.
  const known = await googleClassId(rest.account.issuerId, rest.objectIdHmacKey, {
    ...scope,
    type,
  });
  const knownHash = await sha256Hex(known);
  const identity = { ...writer, bodyDigest };
  if (
    await googleClassVerifiedSince(
      db,
      { classIdHash: knownHash, ...identity },
      now - CLASS_FRESH_MS,
    )
  )
    return 'ok';
  const { result, classId, contacted } = await upsertGoogleClass(rest, type, scope, body);
  const classIdHash = await sha256Hex(classId);
  const mine = { ...writer, classIdHash, bodyDigest, now };
  if (result === 'created' || result === 'unchanged') {
    // A memo hit asked nobody: it records the class but never stamps it verified.
    await recordGoogleClass(db, contacted ? { ...mine, verifiedAt: now } : mine);
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
  await recordGoogleClass(db, { ...mine, verifiedAt: now });
  return 'rewritten';
}
