import type { GoogleType } from '../../../passkit/wallets/google/types.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { canonicalJson } from '../templates/package/hash.ts';
import { GoogleWalletError } from './google-errors.ts';
import {
  type DerivedGoogleId,
  type GoogleClassScope,
  type GoogleObjectScope,
  googleClassId,
  googleObjectIds,
} from './google-ids.ts';
import { copyGoogleProjection, type GoogleGenericProjection } from './google-projection.ts';
import {
  GOOGLE_RESOURCES,
  type GoogleUpsertResult,
  type GoogleWalletRestContext,
  request,
  upsert,
  verifyIdentity,
} from './google-rest.ts';

export interface GoogleRevokeMessage {
  id: string;
  header: string;
  body: string;
}

// The class body each isolate last wrote or found, by class id. A typed class goes through Google
// review each time it is patched (Q16), so an unchanged class is never sent again.
const MAX_KNOWN_CLASSES = 1024;
const classDigests = new Map<string, string>();

export function clearGoogleClassMemo(): void {
  classDigests.clear();
}

/** Whether `actual` carries everything `wanted` says; Google may add fields of its own. */
function covers(actual: unknown, wanted: unknown): boolean {
  if (Array.isArray(wanted))
    return (
      Array.isArray(actual) &&
      actual.length === wanted.length &&
      wanted.every((item, index) => covers(actual[index], item))
    );
  if (wanted !== null && typeof wanted === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false;
    return Object.entries(wanted).every(([key, value]) =>
      covers((actual as Record<string, unknown>)[key], value),
    );
  }
  return actual === wanted;
}

/** Review state is Google's to set, so it is not content. */
const content = ({ reviewStatus: _review, ...rest }: Record<string, unknown>) => rest;

/** Creates the class, or PATCHes it only when what Google holds differs from the compiled body. */
export async function upsertGoogleClass(
  ctx: GoogleWalletRestContext,
  type: GoogleType,
  scope: GoogleClassScope,
  projection: GoogleGenericProjection,
): Promise<GoogleUpsertResult | 'unchanged'> {
  const body = copyGoogleProjection(projection);
  const resource = GOOGLE_RESOURCES[type].class;
  const id = await googleClassId(ctx.account.issuerId, ctx.objectIdHmacKey, { ...scope, type });
  const memo = `${resource}/${id}`;
  const digest = await sha256Hex(canonicalJson(body));
  if (classDigests.get(memo) === digest) return 'unchanged';
  const remember = () => {
    classDigests.delete(memo);
    if (classDigests.size >= MAX_KNOWN_CLASSES) {
      const oldest = classDigests.keys().next().value;
      if (oldest !== undefined) classDigests.delete(oldest);
    }
    classDigests.set(memo, digest);
  };
  try {
    await request(ctx, resource, 'POST', undefined, { ...body, id });
    remember();
    return 'created';
  } catch (error) {
    if (!(error instanceof GoogleWalletError) || error.code !== 'conflict') throw error;
  }
  const held = await verifyIdentity(ctx, resource, id);
  const same = covers(content(held), content(body));
  if (!same) await request(ctx, resource, 'PATCH', id, body);
  remember();
  return same ? 'unchanged' : 'updated';
}

export async function upsertGoogleObject(
  ctx: GoogleWalletRestContext,
  type: GoogleType,
  scope: GoogleObjectScope,
  projection: GoogleGenericProjection,
): Promise<GoogleUpsertResult> {
  const body = copyGoogleProjection(projection);
  const { classId, objectId } = await googleObjectIds(
    ctx.account.issuerId,
    ctx.objectIdHmacKey,
    scope,
  );
  return upsert(ctx, GOOGLE_RESOURCES[type].object, objectId, body, classId);
}

/** The one place an existing object is PATCHed: edits and change messages (GM2) go through it. */
export async function patchGoogleObjectBody(
  ctx: GoogleWalletRestContext,
  type: GoogleType,
  scope: GoogleObjectScope,
  body: GoogleGenericProjection,
): Promise<void> {
  const { objectId } = await googleObjectIds(ctx.account.issuerId, ctx.objectIdHmacKey, scope);
  await request(ctx, GOOGLE_RESOURCES[type].object, 'PATCH', objectId, copyGoogleProjection(body));
}

/**
 * G5: PUTs the object inactive and without its barcode, with one message, then GETs it back. A save
 * link replayed after this can only add an inactive, barcode-less object, so a confirmed revoke is the
 * replay boundary retirement waits for. The PUT carries the object as Google holds it (all its content,
 * its own class), so a revoke needs neither the pass nor the template.
 */
export async function revokeGoogleObject(
  ctx: GoogleWalletRestContext,
  type: GoogleType,
  scope: GoogleObjectScope,
  message: GoogleRevokeMessage,
): Promise<void> {
  const resource = GOOGLE_RESOURCES[type].object;
  const { objectId } = await googleObjectIds(ctx.account.issuerId, ctx.objectIdHmacKey, scope);
  const held = await verifyIdentity(ctx, resource, objectId);
  const { barcode: _b, rotatingBarcode: _r, classReference: _c, ...rest } = held;
  if (typeof rest.classId !== 'string' || !rest.classId.startsWith(`${ctx.account.issuerId}.`))
    throw new GoogleWalletError('invalid_response', `${resource} GET`);
  await request(ctx, resource, 'PUT', objectId as DerivedGoogleId, {
    ...rest,
    state: 'INACTIVE',
    messages: [{ ...message, messageType: 'TEXT' }],
  });
  const confirmed = await verifyIdentity(ctx, resource, objectId);
  if (confirmed.state !== 'INACTIVE' || 'barcode' in confirmed || 'rotatingBarcode' in confirmed)
    // The write may have landed; the outcome is unknown, so the operation is not settled.
    throw new GoogleWalletError('server_error', `${resource} confirm`, 502);
}
