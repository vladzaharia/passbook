import type { ServiceContext } from '../../platform/service-context.ts';
import { isNotFound } from '../passes/builder.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { actorCsrfAuthorityStmt } from './actor-csrf.ts';
import { captureActor } from './asset-authority.ts';
import { photoGrantPurpose } from './asset-types.ts';
import { preparePhotoGrant } from './assets.ts';
import { snapshotCredentialEnv } from './credential-input.ts';
import type { ScanActor } from './guard.ts';
import { verifyLiveTemplateSnapshot } from './live-template-snapshot.ts';
import { confirmedPhotoUrl, photoPolicyForResolved } from './member-photo.ts';
import { isAssetGrantAuthorityFailure, prepareAssetGrantInsertion } from './repo-asset-grants.ts';
import { scanTemplateSnapshotPredicate } from './repo-live-template-snapshot.ts';
import { byIdStmt, candidatesOf } from './repo-lookup.ts';
import { photoUrlTemplateScopePredicate } from './repo-member-photo-url.ts';

export async function scanPhotoUrl(ctx: ServiceContext, actor: ScanActor, passId: string) {
  const pinned = { ...ctx, env: snapshotCredentialEnv(ctx.env) };
  const capturedActor = captureActor(actor);
  const keyset = await requireCredentialRefKeyset(pinned.env.DB, pinned.env);
  const csrf = actorCsrfAuthorityStmt(pinned.env.DB, capturedActor);
  if (!csrf) return null;
  const results = await pinned.env.DB.batch([
    byIdStmt(pinned.env.DB, capturedActor.orgId, passId),
    csrf,
  ]);
  const candidate = candidatesOf(results[0])[0];
  if (!candidate || candidate.credentialKeysetCommitment !== keyset) return null;
  try {
    const purpose = photoGrantPurpose(candidate);
    const templates = await verifyLiveTemplateSnapshot(
      ctx,
      candidate,
      candidate.templateSnapshot,
      purpose,
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
    const templateFence = scanTemplateSnapshotPredicate(
      candidate,
      candidate.templateSnapshot,
      purpose,
    );
    const extra = photoUrlTemplateScopePredicate(templateFence);
    if (!extra) return null;
    const grant = await preparePhotoGrant(
      pinned,
      capturedActor,
      candidate,
      candidate.connectionGeneration,
      candidate.activeTemplateVersion,
    );
    if (!grant) return null;
    const bind = await prepareAssetGrantInsertion(
      pinned,
      grant,
      { recipient: results[1] },
      candidate,
    );
    const inserts = bind(pinned.clock.now(), extra);
    return confirmedPhotoUrl(capturedActor, passId, grant, await pinned.env.DB.batch(inserts));
  } catch (error) {
    if (isNotFound(error) || isAssetGrantAuthorityFailure(error)) return null;
    throw error;
  }
}
