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

/**
 * Creates the class and never rewrites it. A class holds release-level content (release, type, class key), so
 * the same id compiled again must give the same body; when what Google holds differs (two passes of one key
 * compiled different class content, or a compiler update) the class is kept as it is and `drift` is returned
 * for the caller to log. Rewriting it would show every holder in the class the last writer's values and send
 * the class back through Google review (Q16).
 */
export async function upsertGoogleClass(
  ctx: GoogleWalletRestContext,
  type: GoogleType,
  scope: GoogleClassScope,
  projection: GoogleGenericProjection,
): Promise<{
  result: 'created' | 'unchanged' | 'drift';
  classId: DerivedGoogleId;
  /** False when this isolate's memo answered: Google was not asked. */
  contacted: boolean;
}> {
  const body = copyGoogleProjection(projection);
  const resource = GOOGLE_RESOURCES[type].class;
  const id = await googleClassId(ctx.account.issuerId, ctx.objectIdHmacKey, { ...scope, type });
  const memo = `${resource}/${id}`;
  const digest = await sha256Hex(canonicalJson(body));
  const known = classDigests.get(memo);
  if (known !== undefined)
    return { result: known === digest ? 'unchanged' : 'drift', classId: id, contacted: false };
  const remember = () => {
    if (classDigests.size >= MAX_KNOWN_CLASSES) {
      const oldest = classDigests.keys().next().value;
      if (oldest !== undefined) classDigests.delete(oldest);
    }
    classDigests.set(memo, digest);
  };
  try {
    await request(ctx, resource, 'POST', undefined, { ...body, id });
    remember();
    return { result: 'created', classId: id, contacted: true };
  } catch (error) {
    if (!(error instanceof GoogleWalletError) || error.code !== 'conflict') throw error;
  }
  const held = await verifyIdentity(ctx, resource, id);
  const same = covers(content(held), content(body));
  // What this isolate remembers is what Google holds, so a later body is compared with that.
  if (same) remember();
  else classDigests.set(memo, await sha256Hex(canonicalJson(content(held))));
  return { result: same ? 'unchanged' : 'drift', classId: id, contacted: true };
}

/** A newer release's class body: PATCHed once; Google reviews it again (Q16, accepted). */
export async function rewriteGoogleClass(
  ctx: GoogleWalletRestContext,
  type: GoogleType,
  classId: DerivedGoogleId,
  projection: GoogleGenericProjection,
): Promise<void> {
  const body = copyGoogleProjection(projection);
  await request(ctx, GOOGLE_RESOURCES[type].class, 'PATCH', classId, body);
  classDigests.set(
    `${GOOGLE_RESOURCES[type].class}/${classId}`,
    await sha256Hex(canonicalJson(body)),
  );
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

/** What `addMessage` sends: the message PassBook owns, whose id is the ledger row's. */
export interface GoogleAddMessage {
  id: string;
  header: string;
  body: string;
  messageType: 'TEXT' | 'TEXT_AND_NOTIFY';
}

/** The only call Google documents as notifying: object `addMessage` (google-messages.md section 0). */
export async function addGoogleObjectMessage(
  ctx: GoogleWalletRestContext,
  type: GoogleType,
  scope: GoogleObjectScope,
  message: GoogleAddMessage,
): Promise<void> {
  const { objectId } = await googleObjectIds(ctx.account.issuerId, ctx.objectIdHmacKey, scope);
  await request(ctx, GOOGLE_RESOURCES[type].object, 'POST', objectId, { message }, 'addMessage');
}

/** The messageType Google holds for one of our messages on the object, or null when it has none by that id. */
export async function findGoogleObjectMessage(
  ctx: GoogleWalletRestContext,
  type: GoogleType,
  scope: GoogleObjectScope,
  messageId: string,
): Promise<GoogleAddMessage['messageType'] | null> {
  const { objectId } = await googleObjectIds(ctx.account.issuerId, ctx.objectIdHmacKey, scope);
  const held = await verifyIdentity(ctx, GOOGLE_RESOURCES[type].object, objectId);
  const messages = Array.isArray(held.messages) ? (held.messages as unknown[]) : [];
  const hit = messages.find((m) => (m as { id?: unknown } | null)?.id === messageId) as
    | { messageType?: unknown }
    | undefined;
  if (!hit) return null;
  return hit.messageType === 'TEXT_AND_NOTIFY' ? 'TEXT_AND_NOTIFY' : 'TEXT';
}

/**
 * Whether Google reports users on the object, which only a holder's save gives it. An object Google does not
 * have has none. A save callback can be lost; this is the provider's own answer.
 */
export async function googleObjectHasUsers(
  ctx: GoogleWalletRestContext,
  type: GoogleType,
  scope: GoogleObjectScope,
): Promise<boolean> {
  const { objectId } = await googleObjectIds(ctx.account.issuerId, ctx.objectIdHmacKey, scope);
  try {
    return (await verifyIdentity(ctx, GOOGLE_RESOURCES[type].object, objectId)).hasUsers === true;
  } catch (error) {
    if (error instanceof GoogleWalletError && error.code === 'not_found') return false;
    throw error;
  }
}

const NOT_SENT = ['barcode', 'rotatingBarcode', 'classReference', 'smartTapRedemptionValue'];
const OUTPUT_ONLY = ['hasUsers', 'kind', 'version'];
const gone = (value: Record<string, unknown>) =>
  [...NOT_SENT, ...OUTPUT_ONLY].reduce<Record<string, unknown>>((rest, key) => {
    const { [key]: _dropped, ...others } = rest;
    return others;
  }, value);

/**
 * G5: PUTs the object inactive and without its barcode or tap value, with one message, then GETs it back.
 * A save link replayed after this can only add an inactive, barcode-less object, so a confirmed revoke is
 * the replay boundary retirement waits for. The PUT carries the object as Google holds it, so a revoke needs
 * neither the pass nor the template, but only for the class this instance was issued under
 * (`classIdHash`, or the class derived for its partition): another class of the issuer is refused.
 * An object Google does not have (404) is `absent`: nothing remains for a link to show.
 */
export async function revokeGoogleObject(
  ctx: GoogleWalletRestContext,
  type: GoogleType,
  scope: GoogleObjectScope,
  message: GoogleRevokeMessage,
  expectedClassIdHash?: string,
): Promise<'inactive' | 'absent'> {
  const resource = GOOGLE_RESOURCES[type].object;
  const { classId, objectId } = await googleObjectIds(
    ctx.account.issuerId,
    ctx.objectIdHmacKey,
    scope,
  );
  let held: Record<string, unknown>;
  try {
    held = await verifyIdentity(ctx, resource, objectId);
  } catch (error) {
    if (error instanceof GoogleWalletError && error.code === 'not_found') return 'absent';
    throw error;
  }
  const hash = typeof held.classId === 'string' ? await sha256Hex(held.classId) : null;
  if (hash === null || hash !== (expectedClassIdHash ?? (await sha256Hex(classId))))
    throw new GoogleWalletError('conflict', `${resource} class`);
  await request(ctx, resource, 'PUT', objectId, {
    ...gone(held),
    state: 'INACTIVE',
    messages: [{ ...message, messageType: 'TEXT' }],
  });
  const confirmed = await verifyIdentity(ctx, resource, objectId);
  if (
    String(confirmed.state).toUpperCase() !== 'INACTIVE' ||
    NOT_SENT.some((key) => key in confirmed && key !== 'classReference') ||
    confirmed.classId !== held.classId
  )
    // A stale or lagging read: the PUT is a full replace, so the operation retries it.
    throw new GoogleWalletError('invalid_response', `${resource} confirm`);
  return 'inactive';
}
