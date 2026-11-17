import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import { captureActor } from './asset-authority.ts';
import { grantRefs, parseGrant, prepareAssetGrant } from './asset-grant-mint.ts';
import { takeAssetGrantToken } from './asset-sidecar.ts';
import type { AssetGrantPurpose, AssetPassSnapshot } from './asset-types.ts';
import { prepareAssetGrantVerification } from './assets.ts';
import { snapshotCredentialEnv } from './credential-input.ts';
import { pinKeysetOrNull } from './keyset-pin.ts';
import { verifyLiveTemplateSnapshot } from './live-template-snapshot.ts';
import { assetReadCurrent } from './repo-asset-read.ts';
import { scanReadAuthority } from './repo-read-authority.ts';
import { resolveCandidateReadTemplates } from './template-read-snapshot.ts';

const missing = () => new NotFoundError('Image not found.', 'ASSET_NOT_FOUND');

const pinnedContext = (ctx: ServiceContext): ServiceContext => ({
  ...ctx,
  env: snapshotCredentialEnv(ctx.env),
});

/** Mint a short-lived capability for the evaluated snapshot. It is the proof itself: nothing is stored. */
export async function mintAssetGrant(
  ctx: ServiceContext,
  actor: ScanActor,
  snapshot: AssetPassSnapshot,
  connectionGeneration: number | null,
  activeVersion: string | null,
  requirePhoto = false,
  purpose: AssetGrantPurpose = 'commit',
): Promise<string> {
  const plan = await prepareAssetGrant(
    pinnedContext(ctx),
    actor,
    snapshot,
    connectionGeneration,
    activeVersion,
    requirePhoto,
    purpose,
  );
  const token = plan && takeAssetGrantToken(plan);
  if (!token) throw missing();
  return token;
}

/** Standalone verifier for callers that cannot join their own authority batch. */
export async function assetGrantValid(
  ctx: ServiceContext,
  actor: ScanActor,
  snapshot: AssetPassSnapshot,
  connectionGeneration: number | null,
  grant: string | undefined,
  purpose: AssetGrantPurpose = 'commit',
  requirePhoto = false,
): Promise<boolean> {
  const pinned = pinnedContext(ctx);
  const capturedActor = captureActor(actor);
  const verified = await prepareAssetGrantVerification(
    pinned,
    capturedActor,
    snapshot,
    connectionGeneration,
    grant,
    purpose,
    requirePhoto,
  );
  if (!verified || snapshot.credentialKeysetCommitment !== (await pinKeysetOrNull(pinned)))
    return false;
  const templates =
    verified.purpose === 'read'
      ? resolveCandidateReadTemplates(snapshot)
      : await verifyLiveTemplateSnapshot(pinned, snapshot, snapshot.templateSnapshot, 'commit');
  if (!templates) return false;
  return assetReadCurrent(
    pinned.env.DB,
    scanReadAuthority(capturedActor, { now: pinned.clock.now() }),
    capturedActor,
    snapshot,
    verified.requirePhoto,
    verified.credentialRefPrefixes,
  );
}

/** The ref prefixes (hex) a grant carries, or null when it is not a grant. */
export async function grantRefsOf(ctx: ServiceContext, grant: string): Promise<string[] | null> {
  const parsed = parseGrant(grant);
  return parsed && grantRefs(pinnedContext(ctx), parsed);
}
