import { derivedHmacKey } from '../../platform/crypto.ts';
import {
  fromBase64Url,
  randomBytes,
  safeEqualBytes,
  toBase64Url,
  toHex,
} from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import { captureActor } from './asset-authority.ts';
import { grantData } from './asset-claim.ts';
import { holdAssetGrantSidecar } from './asset-sidecar.ts';
import type { AssetGrantPurpose, AssetPassSnapshot, PreparedAssetGrant } from './asset-types.ts';
import { verifyLiveTemplateSnapshot } from './live-template-snapshot.ts';
import {
  CREDENTIAL_REF_PREFIX,
  validCredentialTombstoneRefs,
} from './repo-credential-tombstones.ts';
import { resolveCandidateReadTemplates } from './template-read-snapshot.ts';

/** Every grant lives one hour; redemption refuses anything minted for longer than this plus clock skew. */
export const GRANT_TTL_MS = 3_600_000;
export const GRANT_SKEW_MS = 60_000;
export const NONCE_BYTES = 8;
export const EXPIRY_BYTES = 6;
export const TAG_BYTES = 24;
/** Each retired-credential ref a grant was minted from travels as its leading bytes. */
export const REF_BYTES = CREDENTIAL_REF_PREFIX / 2;
const MAX_REFS = 3;
const MAX_EXPIRY = 2 ** (8 * EXPIRY_BYTES) - 1;

/**
 * A grant is its own proof: nonce, expiry, a truncated HMAC and the prefixes of the keyed refs of
 * the credential it was scanned from. The tag covers the lineage `grantData` reads (recipient, pass,
 * release, photo), the purpose, the expiry, the nonce and those prefixes. Nothing is stored; a
 * redemption rereads the lineage, recomputes the tag and checks no such credential has been retired.
 */
export async function mac(
  ctx: ServiceContext,
  fields: unknown[],
  expiresAt: number,
  refs: readonly string[],
  nonce: Uint8Array,
  purpose: AssetGrantPurpose,
  requirePhoto: boolean,
): Promise<Uint8Array> {
  const key = await derivedHmacKey(ctx.env, 'scan-asset-grant-v2');
  const data = new TextEncoder().encode(
    JSON.stringify([
      ...fields,
      'scan-asset-capability-v2',
      purpose,
      requirePhoto ? 'photo' : 'generic',
      expiresAt,
      refs,
      toBase64Url(nonce),
    ]),
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

function encodeExpiry(expiresAt: number): Uint8Array {
  const bytes = new Uint8Array(EXPIRY_BYTES);
  let rest = expiresAt;
  for (let index = EXPIRY_BYTES - 1; index >= 0; index--) {
    bytes[index] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return bytes;
}

const hexBytes = (hex: string): Uint8Array =>
  Uint8Array.from({ length: hex.length / 2 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );

/** The parts of a grant string, or null when it is not one. */
export function parseGrant(grant: string | undefined): {
  nonce: Uint8Array;
  expiresAt: number;
  tag: Uint8Array;
  /** The ref prefixes as carried: masked by the nonce (`grantRefs` opens them). */
  maskedRefs: Uint8Array;
} | null {
  const head = NONCE_BYTES + EXPIRY_BYTES + TAG_BYTES;
  if (!grant || grant.length > 120 || !/^[A-Za-z0-9_-]+$/.test(grant)) return null;
  try {
    const bytes = fromBase64Url(grant);
    const refBytes = bytes.length - head;
    if (
      refBytes < 0 ||
      refBytes % REF_BYTES !== 0 ||
      refBytes / REF_BYTES > MAX_REFS ||
      toBase64Url(bytes) !== grant
    )
      return null;
    return {
      nonce: bytes.subarray(0, NONCE_BYTES),
      expiresAt: decodeExpiry(bytes.subarray(NONCE_BYTES, NONCE_BYTES + EXPIRY_BYTES)),
      tag: bytes.subarray(NONCE_BYTES + EXPIRY_BYTES, head),
      maskedRefs: bytes.slice(head),
    };
  } catch {
    return null;
  }
}

/**
 * The carried ref prefixes are masked with bytes only the server can derive from the nonce, so two
 * grants minted from the same credential share no bytes in their URLs.
 */
async function refMask(
  ctx: ServiceContext,
  nonce: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await derivedHmacKey(ctx.env, 'scan-asset-grant-v2');
  const data = new TextEncoder().encode(
    JSON.stringify(['scan-asset-ref-mask-v2', toBase64Url(nonce)]),
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data)).subarray(0, length);
}

const xor = (a: Uint8Array, b: Uint8Array) => a.map((byte, index) => byte ^ (b[index] ?? 0));

/** The ref prefixes (hex) a parsed grant carries. */
export async function grantRefs(
  ctx: ServiceContext,
  parsed: { nonce: Uint8Array; maskedRefs: Uint8Array },
): Promise<string[]> {
  const plain = xor(parsed.maskedRefs, await refMask(ctx, parsed.nonce, parsed.maskedRefs.length));
  return Array.from({ length: plain.length / REF_BYTES }, (_, index) =>
    toHex(plain.subarray(index * REF_BYTES, (index + 1) * REF_BYTES)),
  );
}

function decodeExpiry(bytes: Uint8Array): number {
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return value;
}

/** True when `tag` is the (truncated) MAC of the grant, compared in constant time. */
export const tagMatches = (tag: Uint8Array, expected: Uint8Array): boolean =>
  safeEqualBytes(tag, expected.subarray(0, TAG_BYTES));

/** Mint a capability from the evaluated snapshot. Writes nothing. */
export async function prepareAssetGrant(
  ctx: ServiceContext,
  actor: ScanActor,
  snapshot: AssetPassSnapshot,
  connectionGeneration: number | null,
  activeVersion: string | null,
  requirePhoto: boolean,
  purpose: AssetGrantPurpose,
): Promise<PreparedAssetGrant | null> {
  if (
    !validCredentialTombstoneRefs(snapshot.credentialTombstoneRefs) ||
    new Set(snapshot.credentialTombstoneRefs).size !== snapshot.credentialTombstoneRefs.length
  )
    return null;
  const refs = snapshot.credentialTombstoneRefs.map((ref) => ref.slice(0, CREDENTIAL_REF_PREFIX));
  const capturedActor = captureActor(actor);
  const passId = snapshot.pass.id;
  const [data, templates] = await Promise.all([
    grantData(
      ctx,
      capturedActor,
      snapshot,
      connectionGeneration,
      activeVersion,
      requirePhoto,
      purpose,
    ),
    purpose === 'read'
      ? resolveCandidateReadTemplates(snapshot)
      : verifyLiveTemplateSnapshot(ctx, snapshot, snapshot.templateSnapshot, 'commit'),
  ]);
  if (!data || !templates) return null;
  const expiresAt = ctx.clock.now() + GRANT_TTL_MS;
  if (!Number.isSafeInteger(expiresAt) || expiresAt > MAX_EXPIRY) return null;
  const nonce = randomBytes(NONCE_BYTES);
  const tag = await mac(ctx, data.fields, expiresAt, refs, nonce, purpose, requirePhoto);
  const bytes = new Uint8Array(NONCE_BYTES + EXPIRY_BYTES + TAG_BYTES + refs.length * REF_BYTES);
  bytes.set(nonce);
  bytes.set(encodeExpiry(expiresAt), NONCE_BYTES);
  bytes.set(tag.subarray(0, TAG_BYTES), NONCE_BYTES + EXPIRY_BYTES);
  const plain = Uint8Array.from(refs.flatMap((ref) => [...hexBytes(ref)]));
  bytes.set(
    xor(plain, await refMask(ctx, nonce, plain.length)),
    NONCE_BYTES + EXPIRY_BYTES + TAG_BYTES,
  );
  const plan: PreparedAssetGrant = Object.freeze({
    orgId: capturedActor.orgId,
    mode: capturedActor.mode,
    passId,
    expiresAt,
    requirePhoto,
    purpose,
  });
  holdAssetGrantSidecar(plan, { token: toBase64Url(bytes), actor: capturedActor });
  return plan;
}
