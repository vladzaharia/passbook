import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import { captureActor } from './asset-authority.ts';
import { activeWallet, grantData } from './asset-claim.ts';
import { mac, parseGrant, prepareAssetGrant, tagMatches } from './asset-grant-mint.ts';
import { takeAssetGrantToken } from './asset-sidecar.ts';
import {
  type AssetGrantPurpose,
  type AssetGrantSource,
  type AssetPassSnapshot,
  type AssetWalletSnapshot,
  type PreparedAssetGrant,
  photoGrantPurpose,
} from './asset-types.ts';
import { snapshotCredentialEnv } from './credential-input.ts';
import { pinKeysetOrNull } from './keyset-pin.ts';
import { verifyLiveTemplateSnapshot } from './live-template-snapshot.ts';
import { assetReadCurrent } from './repo-asset-read.ts';
import { scanReadAuthority } from './repo-read-authority.ts';
import { resolveCandidateReadTemplates } from './template-read-snapshot.ts';

const missing = () => new NotFoundError('Image not found.', 'ASSET_NOT_FOUND');

/** Freeze the KEKs once before any asynchronous capability work. */
function pinnedContext(ctx: ServiceContext): ServiceContext {
  return { ...ctx, env: snapshotCredentialEnv(ctx.env) };
}

/** A photo capability; its URL is built only for the recipient it was minted for (`confirmedPhotoUrl`). */
export function preparePhotoGrant(
  ctx: ServiceContext,
  actor: ScanActor,
  snapshot: AssetPassSnapshot,
  connectionGeneration: number | null,
  activeVersion: string | null,
  source?: AssetGrantSource,
): Promise<PreparedAssetGrant | null> {
  return prepareAssetGrant(
    pinnedContext(ctx),
    actor,
    snapshot,
    connectionGeneration,
    activeVersion,
    source,
    true,
    photoGrantPurpose(snapshot),
  );
}

/** A capability for the pass card's other images. */
export const prepareGenericAssetGrant = (
  ctx: ServiceContext,
  actor: ScanActor,
  snapshot: AssetPassSnapshot,
  connectionGeneration: number | null,
  activeVersion: string | null,
  purpose: AssetGrantPurpose,
  source?: AssetGrantSource,
): Promise<PreparedAssetGrant | null> =>
  prepareAssetGrant(
    pinnedContext(ctx),
    actor,
    snapshot,
    connectionGeneration,
    activeVersion,
    source,
    false,
    purpose,
  );

/** Mint a short-lived capability for the evaluated snapshot. It is the proof itself: nothing is stored. */
export async function mintAssetGrant(
  ctx: ServiceContext,
  actor: ScanActor,
  snapshot: AssetPassSnapshot,
  connectionGeneration: number | null,
  activeVersion: string | null,
  source?: AssetGrantSource,
  requirePhoto = false,
  purpose: AssetGrantPurpose = 'commit',
): Promise<string> {
  const plan = await prepareAssetGrant(
    pinnedContext(ctx),
    actor,
    snapshot,
    connectionGeneration,
    activeVersion,
    source,
    requirePhoto,
    purpose,
  );
  const token = plan && takeAssetGrantToken(plan);
  if (!token) throw missing();
  return token;
}

/** A verified capability: the guard input for every later SQL fence, and its own expiry. */
export interface VerifiedAssetGrant {
  passId: string;
  purpose: AssetGrantPurpose;
  requirePhoto: boolean;
  /** Leading hex of the keyed refs of the credential the grant was scanned from. */
  credentialRefPrefixes: readonly string[];
  expiresAt: number;
}

/** A well-formed capability string, before any read. */
export const assetGrantWellFormed = (grant: string | undefined): boolean =>
  parseGrant(grant) !== null;

/**
 * Recompute the capability from the lineage `snapshot` was just read with and compare in constant
 * time. Any move of the actor, pass, release or photo since the mint changes the tag.
 */
export async function prepareAssetGrantVerification(
  ctx: ServiceContext,
  actor: ScanActor,
  snapshot: AssetPassSnapshot,
  connectionGeneration: number | null,
  grant: string | undefined,
  source?: AssetGrantSource,
  purpose: AssetGrantPurpose = 'commit',
  requirePhoto = false,
): Promise<VerifiedAssetGrant | null> {
  const pinned = pinnedContext(ctx);
  const parsed = parseGrant(grant);
  if (!parsed || !Number.isSafeInteger(parsed.expiresAt) || parsed.expiresAt <= pinned.clock.now())
    return null;
  const capturedActor = captureActor(actor);
  const passId = snapshot.pass.id;
  const capturedSource = source
    ? { sourceId: source.sourceId, eventId: source.eventId, actor: captureActor(source.actor) }
    : undefined;
  const activeVersion = snapshot.activeReleaseVersion ?? snapshot.pass.templateVersion;
  const data = await grantData(
    pinned,
    capturedActor,
    snapshot,
    connectionGeneration,
    activeVersion,
    capturedSource,
    requirePhoto,
    purpose,
  );
  if (!data) return null;
  const purposes: AssetGrantPurpose[] =
    purpose === 'read' && !requirePhoto && snapshot.displayTemplateVersion === activeVersion
      ? ['read', 'commit']
      : [purpose];
  const expected = await Promise.all(
    purposes.map((candidate) =>
      mac(
        pinned,
        data.fields,
        parsed.expiresAt,
        parsed.refs,
        parsed.nonce,
        candidate,
        requirePhoto,
      ),
    ),
  );
  const matched = expected.findIndex((tag) => tagMatches(parsed.tag, tag));
  const verifiedPurpose = purposes[matched];
  if (!verifiedPurpose || parsed.expiresAt <= pinned.clock.now()) return null;
  return {
    passId,
    credentialRefPrefixes: parsed.refs,
    requirePhoto,
    purpose: verifiedPurpose,
    expiresAt: parsed.expiresAt,
  };
}

/** Standalone verifier for callers that cannot join their own authority batch. */
export async function assetGrantValid(
  ctx: ServiceContext,
  actor: ScanActor,
  snapshot: AssetPassSnapshot,
  connectionGeneration: number | null,
  grant: string | undefined,
  source?: AssetGrantSource,
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
    source,
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
  const now = pinned.clock.now();
  return assetReadCurrent(
    pinned.env.DB,
    scanReadAuthority(capturedActor, { now }),
    capturedActor,
    snapshot,
    verified.requirePhoto,
    verified.credentialRefPrefixes,
  );
}

export function assetWalletActive(snapshot: AssetWalletSnapshot, now: number): boolean {
  return activeWallet(snapshot, now) !== null;
}

export const assetBaseUrl = (passId: string) => `/api/v1/scan/passes/${passId}/assets/`;
