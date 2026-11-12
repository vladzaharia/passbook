import { NotFoundError } from '../../platform/errors.ts';
import { fromBase64Url, safeEqualBytes, sha256Hex, toBase64Url } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import { captureActor } from './asset-authority.ts';
import { activeWallet, grantData, validRefs } from './asset-claim.ts';
import { mac, NONCE_BYTES, prepareAssetGrant, TAG_BYTES, TOKEN_BYTES } from './asset-grant-mint.ts';
import type { AssetGrantBatchResult } from './asset-grant-results.ts';
import { assetSnapshotInput, assetSnapshotProofFromInput } from './asset-secrets.ts';
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
import { verifyLiveTemplateSnapshot } from './live-template-snapshot.ts';
import {
  getAssetGrant,
  isAssetGrantAuthorityFailure,
  prepareAssetGrantInsertion,
} from './repo-asset-grants.ts';
import { type AssetGrantGuardInput, prepareAssetGrantGuardParts } from './repo-asset-lineage.ts';
import { assetGrantPredicatesCurrent } from './repo-asset-read.ts';
import {
  scanCandidateTemplateReadPredicate,
  scanTemplateSnapshotPredicate,
} from './repo-live-template-snapshot.ts';
import { resolveCandidateReadTemplates } from './template-read-snapshot.ts';

const missing = () => new NotFoundError('Image not found.', 'ASSET_NOT_FOUND');

/** Freeze the KEKs once before any asynchronous capability work. */
function pinnedContext(ctx: ServiceContext): ServiceContext {
  return { ...ctx, env: snapshotCredentialEnv(ctx.env) };
}

/** An internal cloneable plan; the caller must confirm its guarded insert before exposing token. */
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

/** Generic card assets share the deferred guarded-insert contract with photos. */
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

/** Release the request-local capability only after every guarded batch assertion succeeds. */
export function confirmAssetGrantToken(
  plan: PreparedAssetGrant,
  results: readonly AssetGrantBatchResult[] | undefined,
): string | null {
  return takeAssetGrantToken(plan, results);
}

/** Insert a short-lived opaque capability only when all original authority is still current. */
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
  const pinned = pinnedContext(ctx);
  const plan = await prepareAssetGrant(
    pinned,
    actor,
    snapshot,
    connectionGeneration,
    activeVersion,
    source,
    requirePhoto,
    purpose,
  );
  if (!plan) throw missing();
  try {
    const bind = await prepareAssetGrantInsertion(pinned, plan, undefined, snapshot);
    const statements = bind(pinned.clock.now(), undefined);
    const token = confirmAssetGrantToken(plan, await pinned.env.DB.batch(statements));
    if (!token) throw missing();
    return token;
  } catch (error) {
    if (isAssetGrantAuthorityFailure(error)) throw missing();
    throw error;
  }
}

/** A verified capability retains its original keyed refs for every later SQL fence. */
export type VerifiedAssetGrant = AssetGrantGuardInput & {
  storedGrant: { tokenHash: string; expiresAt: number; credentialRefsJson: string };
};

function tokenBytes(grant: string | undefined): Uint8Array | null {
  if (!grant || !/^[A-Za-z0-9_-]{54}$/.test(grant)) return null;
  try {
    const bytes = fromBase64Url(grant);
    return bytes.length === TOKEN_BYTES && toBase64Url(bytes) === grant ? bytes : null;
  } catch {
    return null;
  }
}

export async function assetGrantTokenHash(grant: string | undefined): Promise<string | null> {
  return tokenBytes(grant) && grant ? sha256Hex(grant) : null;
}

/** Verify the capability against a batch-loaded provenance row without performing D1 reads. */
export async function prepareAssetGrantVerification(
  ctx: ServiceContext,
  actor: ScanActor,
  snapshot: AssetPassSnapshot,
  connectionGeneration: number | null,
  grant: string | undefined,
  stored: { expiresAt: number; credentialRefs: string } | null,
  source?: AssetGrantSource,
  purpose: AssetGrantPurpose = 'commit',
  requirePhoto = false,
): Promise<VerifiedAssetGrant | null> {
  const pinned = pinnedContext(ctx);
  const capturedActor = captureActor(actor);
  const passId = snapshot.pass.id;
  const capturedSource = source
    ? { sourceId: source.sourceId, eventId: source.eventId, actor: captureActor(source.actor) }
    : undefined;
  const bytes = tokenBytes(grant);
  if (
    !bytes ||
    !grant ||
    !stored ||
    !Number.isSafeInteger(stored.expiresAt) ||
    stored.expiresAt <= pinned.clock.now()
  )
    return null;
  let refs: unknown;
  try {
    refs = JSON.parse(stored.credentialRefs);
  } catch {
    return null;
  }
  if (!validRefs(refs) || stored.credentialRefs !== JSON.stringify(refs)) return null;
  const originalSnapshot = { ...snapshot, credentialTombstoneRefs: refs };
  const capturedInput = assetSnapshotInput(originalSnapshot);
  const activeVersion = snapshot.activeReleaseVersion ?? snapshot.pass.templateVersion;
  const [snapshotProof, data] = await Promise.all([
    assetSnapshotProofFromInput(pinned.env, capturedInput),
    grantData(
      pinned,
      capturedActor,
      originalSnapshot,
      connectionGeneration,
      activeVersion,
      refs,
      capturedSource,
      requirePhoto,
      purpose,
    ),
  ]);
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
        stored.expiresAt,
        refs,
        bytes.subarray(0, NONCE_BYTES),
        candidate,
        requirePhoto,
      ),
    ),
  );
  const matched = expected.findIndex((tag) =>
    safeEqualBytes(bytes.subarray(NONCE_BYTES), tag.subarray(0, TAG_BYTES)),
  );
  if (matched < 0 || stored.expiresAt <= pinned.clock.now()) return null;
  const verifiedPurpose = purposes[matched];
  if (!verifiedPurpose) return null;
  const tokenHash = await sha256Hex(grant);
  if (assetSnapshotInput(originalSnapshot) !== capturedInput) return null;
  return {
    passId,
    snapshotProof,
    actor: capturedActor,
    recipientSession: data.recipientSession,
    source: capturedSource,
    sourceSession: data.sourceSession,
    connectionGeneration,
    activeVersion,
    credentialTombstoneRefs: refs,
    requirePhoto,
    purpose: verifiedPurpose,
    storedGrant: {
      tokenHash,
      expiresAt: stored.expiresAt,
      credentialRefsJson: stored.credentialRefs,
    },
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
  const input = assetSnapshotInput(snapshot);
  const capturedActor = captureActor(actor);
  const capturedSource = source
    ? { sourceId: source.sourceId, eventId: source.eventId, actor: captureActor(source.actor) }
    : undefined;
  const tokenHash = await assetGrantTokenHash(grant);
  if (!tokenHash) return false;
  const stored = await getAssetGrant(
    pinned.env.DB,
    tokenHash,
    capturedActor.orgId,
    capturedActor.mode,
    pinned.clock.now(),
  );
  const verified = await prepareAssetGrantVerification(
    pinned,
    capturedActor,
    snapshot,
    connectionGeneration,
    grant,
    stored,
    capturedSource,
    purpose,
    requirePhoto,
  );
  if (!verified || assetSnapshotInput(snapshot) !== input) return false;
  const templates =
    verified.purpose === 'read'
      ? resolveCandidateReadTemplates(snapshot)
      : await verifyLiveTemplateSnapshot(pinned, snapshot, snapshot.templateSnapshot, 'commit');
  if (!templates || assetSnapshotInput(snapshot) !== input) return false;
  const template =
    verified.purpose === 'read'
      ? scanCandidateTemplateReadPredicate(snapshot)
      : scanTemplateSnapshotPredicate(snapshot, snapshot.templateSnapshot, 'commit');
  const originalSnapshot = {
    ...snapshot,
    credentialTombstoneRefs: verified.credentialTombstoneRefs,
  };
  const makeGuard = await prepareAssetGrantGuardParts(
    pinned,
    verified,
    undefined,
    originalSnapshot,
  );
  return makeGuard
    ? assetGrantPredicatesCurrent(pinned.env.DB, makeGuard(pinned.clock.now()), template)
    : false;
}

export function assetWalletActive(snapshot: AssetWalletSnapshot, now: number): boolean {
  return activeWallet(snapshot, now) !== null;
}

export const assetBaseUrl = (passId: string) => `/api/v1/scan/passes/${passId}/assets/`;
