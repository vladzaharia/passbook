import { derivedHmacKey } from '../../platform/crypto.ts';
import { randomBytes, sha256Hex, toBase64Url } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import { captureActor } from './asset-authority.ts';
import { grantData, validRefs } from './asset-claim.ts';
import { assetSnapshotInput, assetSnapshotProofFromInput } from './asset-secrets.ts';
import { holdAssetGrantSidecar } from './asset-sidecar.ts';
import type {
  AssetGrantPurpose,
  AssetGrantSource,
  AssetPassSnapshot,
  PreparedAssetGrant,
} from './asset-types.ts';
import { verifyLiveTemplateSnapshot } from './live-template-snapshot.ts';
import { resolveCandidateReadTemplates } from './template-read-snapshot.ts';

const HOUR = 3_600_000;
export const NONCE_BYTES = 16;
export const TAG_BYTES = 24;
export const TOKEN_BYTES = NONCE_BYTES + TAG_BYTES;

export async function mac(
  ctx: ServiceContext,
  fields: unknown[],
  expiresAt: number,
  refs: readonly string[],
  nonce: Uint8Array,
  purpose: AssetGrantPurpose,
  requirePhoto: boolean,
): Promise<Uint8Array> {
  const key = await derivedHmacKey(ctx.env, 'scan-asset');
  const data = new TextEncoder().encode(
    JSON.stringify([
      ...fields,
      'scan-asset-capability-v1',
      purpose,
      requirePhoto ? 'photo' : 'generic',
      expiresAt,
      refs,
      toBase64Url(nonce),
    ]),
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

export async function prepareAssetGrant(
  ctx: ServiceContext,
  actor: ScanActor,
  snapshot: AssetPassSnapshot,
  connectionGeneration: number | null,
  activeVersion: string | null,
  source: AssetGrantSource | undefined,
  requirePhoto: boolean,
  purpose: AssetGrantPurpose,
): Promise<PreparedAssetGrant | null> {
  const capturedActor = captureActor(actor);
  const passId = snapshot.pass.id;
  const capturedInput = assetSnapshotInput(snapshot);
  const capturedSource = source
    ? { sourceId: source.sourceId, eventId: source.eventId, actor: captureActor(source.actor) }
    : undefined;
  if (!validRefs(snapshot.credentialTombstoneRefs)) return null;
  const refs = Object.freeze([...snapshot.credentialTombstoneRefs]);
  const [snapshotProof, data, templates] = await Promise.all([
    assetSnapshotProofFromInput(ctx.env, capturedInput),
    grantData(
      ctx,
      capturedActor,
      snapshot,
      connectionGeneration,
      activeVersion,
      refs,
      capturedSource,
      requirePhoto,
      purpose,
    ),
    purpose === 'read'
      ? resolveCandidateReadTemplates(snapshot)
      : verifyLiveTemplateSnapshot(ctx, snapshot, snapshot.templateSnapshot, 'commit'),
  ]);
  if (!data || !templates) return null;
  const now = ctx.clock.now();
  const expiresAt = now + HOUR;
  if (!Number.isSafeInteger(expiresAt)) return null;
  const nonce = randomBytes(NONCE_BYTES);
  const tag = await mac(ctx, data.fields, expiresAt, refs, nonce, purpose, requirePhoto);
  const bytes = new Uint8Array(TOKEN_BYTES);
  bytes.set(nonce);
  bytes.set(tag.subarray(0, TAG_BYTES), NONCE_BYTES);
  const token = toBase64Url(bytes);
  const tokenHash = await sha256Hex(token);
  if (assetSnapshotInput(snapshot) !== capturedInput) return null;
  const plan: PreparedAssetGrant = Object.freeze({
    tokenHash,
    orgId: capturedActor.orgId,
    mode: capturedActor.mode,
    expiresAt,
    credentialRefsJson: JSON.stringify(refs),
    guard: Object.freeze({
      passId,
      snapshotProof,
      connectionGeneration,
      activeVersion,
      credentialTombstoneRefs: refs,
      requirePhoto,
      purpose,
    }),
  });
  holdAssetGrantSidecar(plan, {
    token,
    actor: capturedActor,
    source: capturedSource,
    recipientSession: data.recipientSession,
    sourceSession: data.sourceSession,
  });
  return plan;
}
