import { first } from '../../platform/db.ts';
import {
  type ConnectionPassContext,
  connectionPassParams,
  connectionPassPredicate,
  validConnectionPassContext,
} from './repo-connection-context.ts';
import type { Pass } from './repo-map.ts';
import {
  approvedReleaseFence,
  type PassReleaseSnapshot,
  validPassReleaseSnapshot,
} from './repo-release.ts';

// sync_error_code is volatile bookkeeping the connection sync stamps behind a full pass and release snapshot;
// allowlisted in tools/authority-scope.ts.

/** Changes sync state only while the complete connector and holder snapshot still matches. */
export async function applyConnectionState(
  db: D1Database,
  context: ConnectionPassContext,
  expectedPass: Pick<Pass, 'holderEmail' | 'ownerUserId' | 'templateId'>,
  code: string | null,
  release?: PassReleaseSnapshot,
): Promise<{
  holderEmail: string | null;
  ownerUserId: string | null;
  linkGeneration: number;
  version: number;
} | null> {
  if (!validConnectionPassContext(context)) return null;
  const proof = context.retainedReleaseProof;
  if (
    proof &&
    (!validPassReleaseSnapshot(release) ||
      release.id !== proof.id ||
      release.generation !== proof.generation)
  )
    return null;
  const fence =
    proof && release
      ? approvedReleaseFence(
          release,
          expectedPass.templateId,
          context.orgId,
          context.mode,
          proof.version,
        )
      : undefined;
  const row = await first<{
    holder_email: string | null;
    owner_user_id: string | null;
    link_generation: number;
    version: number;
  }>(
    db,
    `UPDATE passes SET sync_error_code = ?
     WHERE id = ? AND holder_email IS ? AND owner_user_id IS ? AND ${connectionPassPredicate}
       ${fence ? `AND template_id = ? AND ${fence.sql}` : ''}
     RETURNING holder_email, owner_user_id, link_generation, version`,
    [
      code,
      context.passId,
      expectedPass.holderEmail,
      expectedPass.ownerUserId,
      ...connectionPassParams(context),
      ...(fence ? [expectedPass.templateId, ...fence.params] : []),
    ],
  );
  return row
    ? {
        holderEmail: row.holder_email,
        ownerUserId: row.owner_user_id,
        linkGeneration: row.link_generation,
        version: row.version,
      }
    : null;
}
