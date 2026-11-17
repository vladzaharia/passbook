import type { ServiceContext } from '../../platform/service-context.ts';
import { isNotFound } from '../passes/builder.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { captureActor } from './asset-authority.ts';
import { photoGrantPurpose } from './asset-types.ts';
import { preparePhotoGrant } from './assets.ts';
import { snapshotCredentialEnv } from './credential-input.ts';
import type { ScanActor } from './guard.ts';
import { verifyLiveTemplateSnapshot } from './live-template-snapshot.ts';
import { photoGrantUrl, photoPolicyForResolved } from './member-photo.ts';
import { byIdStmt, candidatesOf } from './repo-lookup.ts';

/** The photo URL a scanner actor is shown for a pass today, or null when policy or lineage refuses it. */
export async function scanPhotoUrl(ctx: ServiceContext, actor: ScanActor, passId: string) {
  const pinned = { ...ctx, env: snapshotCredentialEnv(ctx.env) };
  const capturedActor = captureActor(actor);
  const keyset = await requireCredentialRefKeyset(pinned.env.DB, pinned.env);
  const [result] = await pinned.env.DB.batch([
    byIdStmt(pinned.env.DB, capturedActor.orgId, passId),
  ]);
  const candidate = candidatesOf(result)[0];
  if (!candidate || candidate.credentialKeysetCommitment !== keyset) return null;
  try {
    const templates = await verifyLiveTemplateSnapshot(
      ctx,
      candidate,
      candidate.templateSnapshot,
      photoGrantPurpose(candidate),
    );
    if (
      !templates ||
      !photoPolicyForResolved(
        capturedActor,
        candidate,
        templates.pinned,
        templates.active,
        pinned.clock.now(),
      )
    )
      return null;
    const grant = await preparePhotoGrant(
      pinned,
      capturedActor,
      candidate,
      candidate.connectionGeneration,
      candidate.activeTemplateVersion,
    );
    return grant ? photoGrantUrl(capturedActor, passId, grant) : null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}
