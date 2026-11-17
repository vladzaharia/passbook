import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import { captureActor } from './asset-authority.ts';
import { activeWallet, grantData } from './asset-claim.ts';
import {
  GRANT_SKEW_MS,
  GRANT_TTL_MS,
  grantRefs,
  mac,
  parseGrant,
  prepareAssetGrant,
  tagMatches,
} from './asset-grant-mint.ts';
import {
  type AssetGrantPurpose,
  type AssetPassSnapshot,
  type AssetWalletSnapshot,
  type PreparedAssetGrant,
  photoGrantPurpose,
} from './asset-types.ts';
import { snapshotCredentialEnv } from './credential-input.ts';

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
): Promise<PreparedAssetGrant | null> {
  return prepareAssetGrant(
    pinnedContext(ctx),
    actor,
    snapshot,
    connectionGeneration,
    activeVersion,
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
): Promise<PreparedAssetGrant | null> =>
  prepareAssetGrant(
    pinnedContext(ctx),
    actor,
    snapshot,
    connectionGeneration,
    activeVersion,
    false,
    purpose,
  );

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
  purpose: AssetGrantPurpose = 'commit',
  requirePhoto = false,
): Promise<VerifiedAssetGrant | null> {
  const pinned = pinnedContext(ctx);
  const parsed = parseGrant(grant);
  const start = pinned.clock.now();
  if (
    !parsed ||
    !Number.isSafeInteger(parsed.expiresAt) ||
    parsed.expiresAt <= start ||
    // No grant is minted for longer than its time to live: a longer expiry is not ours.
    parsed.expiresAt > start + GRANT_TTL_MS + GRANT_SKEW_MS
  )
    return null;
  const refs = await grantRefs(pinned, parsed);
  const capturedActor = captureActor(actor);
  const passId = snapshot.pass.id;
  const activeVersion = snapshot.activeReleaseVersion ?? snapshot.pass.templateVersion;
  const data = await grantData(
    pinned,
    capturedActor,
    snapshot,
    connectionGeneration,
    activeVersion,
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
      mac(pinned, data.fields, parsed.expiresAt, refs, parsed.nonce, candidate, requirePhoto),
    ),
  );
  const matched = expected.findIndex((tag) => tagMatches(parsed.tag, tag));
  const verifiedPurpose = purposes[matched];
  if (!verifiedPurpose || parsed.expiresAt <= pinned.clock.now()) return null;
  return {
    passId,
    credentialRefPrefixes: refs,
    requirePhoto,
    purpose: verifiedPurpose,
    expiresAt: parsed.expiresAt,
  };
}

export function assetWalletActive(snapshot: AssetWalletSnapshot, now: number): boolean {
  return activeWallet(snapshot, now) !== null;
}

export const assetBaseUrl = (passId: string) => `/api/v1/scan/passes/${passId}/assets/`;
