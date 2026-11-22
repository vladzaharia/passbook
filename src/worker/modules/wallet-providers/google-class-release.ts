import type { GoogleType } from '../../../passkit/wallets/google/types.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { GoogleClassScope } from './google-ids.ts';
import type { GoogleGenericProjection } from './google-projection.ts';
import type { GoogleWalletRestContext } from './google-rest.ts';
import { rewriteGoogleClass, upsertGoogleClass } from './google-rest-typed.ts';
import {
  type GoogleClassWrite,
  getGoogleClassWrite,
  putGoogleClassWrite,
} from './repo-google-class.ts';

/**
 * A class is written once per release. The release that last wrote it is recorded; a newer release of the
 * template that compiles a different class body (a new event name, venue, date or logo) rewrites it once,
 * so existing holders follow the template and Google reviews it again (Q16, accepted). The same release
 * never rewrites it: two passes of one release compiling different bodies is `drift`, and the class stays.
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
  const { result, classId } = await upsertGoogleClass(rest, type, scope, body);
  const classIdHash = await sha256Hex(classId);
  const record = () => putGoogleClassWrite(db, { ...writer, classIdHash, now });
  if (result !== 'drift') {
    await record();
    return 'ok';
  }
  const written = await getGoogleClassWrite(db, classIdHash);
  if (written && written.releaseGeneration >= writer.releaseGeneration) return 'drift';
  await rewriteGoogleClass(rest, type, classId, body);
  await record();
  return 'rewritten';
}
