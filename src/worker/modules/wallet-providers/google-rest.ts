import type { GoogleValidatedAccount } from './google-credentials.ts';
import {
  GoogleWalletError,
  googleFetch,
  googleHttpError,
  isGoogleNotifyQuota,
} from './google-errors.ts';
import {
  type DerivedGoogleId,
  type GoogleClassScope,
  type GoogleObjectScope,
  googleClassId,
  googleObjectIds,
} from './google-ids.ts';
import { isGoogleBearerToken } from './google-oauth.ts';
import { copyGoogleProjection, type GoogleGenericProjection } from './google-projection.ts';

const WALLET_API = 'https://walletobjects.googleapis.com/walletobjects/v1';

/** The REST collection of each type's class and object (google-wallet.md section 1). */
export const GOOGLE_RESOURCES = {
  generic: { class: 'genericClass', object: 'genericObject' },
  event: { class: 'eventTicketClass', object: 'eventTicketObject' },
  loyalty: { class: 'loyaltyClass', object: 'loyaltyObject' },
  gift: { class: 'giftCardClass', object: 'giftCardObject' },
  offer: { class: 'offerClass', object: 'offerObject' },
} as const;
export type Resource = (typeof GOOGLE_RESOURCES)[keyof typeof GOOGLE_RESOURCES]['class' | 'object'];
export type GoogleUpsertResult = 'created' | 'updated';

export interface GoogleWalletRestContext {
  account: GoogleValidatedAccount;
  objectIdHmacKey: Uint8Array;
  accessToken: string;
  fetcher?: typeof fetch;
  /** Injected clock for HTTP-date `Retry-After` values (`ctx.clock.now`). */
  now?: () => number;
  /** The access token came from the cache, so a 401 may only mean it went stale. */
  tokenCached?: boolean;
  /** Called on a 401 so the caller can drop the cached access token. */
  onUnauthorized?: () => void;
}

// Resources this isolate has already created or identity-checked. Later updates PATCH directly
// (one request instead of POST, GET, PATCH); a 404 forgets the entry and takes the create path.
const MAX_KNOWN_RESOURCES = 4096;
const knownResources = new Set<string>();

function remember(resource: Resource, id: DerivedGoogleId): void {
  const key = `${resource}/${id}`;
  knownResources.delete(key);
  if (knownResources.size >= MAX_KNOWN_RESOURCES) {
    const oldest = knownResources.keys().next().value;
    if (oldest !== undefined) knownResources.delete(oldest);
  }
  knownResources.add(key);
}

export function clearGoogleRestMemo(): void {
  knownResources.clear();
}

const MAX_ERROR_BYTES = 8 * 1024;

async function isQuotaResponse(response: Response): Promise<boolean> {
  try {
    const reader = response.body?.getReader();
    if (!reader) return false;
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < MAX_ERROR_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value.subarray(0, MAX_ERROR_BYTES - size));
      size += chunks[chunks.length - 1]?.byteLength ?? 0;
    }
    void reader.cancel().catch(() => undefined);
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.byteLength;
    }
    return isGoogleNotifyQuota(response.status, new TextDecoder().decode(bytes));
  } catch {
    return false;
  }
}

export async function request(
  ctx: GoogleWalletRestContext,
  resource: Resource,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  id?: DerivedGoogleId,
  body?: Record<string, unknown>,
  action?: 'addMessage',
): Promise<Response> {
  if (!isGoogleBearerToken(ctx.accessToken)) throw new GoogleWalletError('invalid_input', 'rest');
  // An id outside the source issuer's namespace is another issuer's resource, whatever its brand.
  if (id && !id.startsWith(`${ctx.account.issuerId}.`))
    throw new GoogleWalletError('invalid_input', 'rest');
  const operation = `${resource} ${action ?? method}`;
  const response = await googleFetch(
    ctx.fetcher ?? globalThis.fetch,
    `${WALLET_API}/${resource}${id ? `/${encodeURIComponent(id)}` : ''}${action ? `/${action}` : ''}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${ctx.accessToken}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    operation,
  );
  if (!response.ok) {
    if (response.status === 401) ctx.onUnauthorized?.();
    // The body is read for the quota check only; it is never kept, logged or put in the error.
    if (action === 'addMessage' && (await isQuotaResponse(response)))
      throw new GoogleWalletError(
        'quota_exceeded',
        operation,
        response.status,
        googleHttpError(operation, response.status, response.headers, ctx.now?.()).retryAfterMs,
      );
    throw googleHttpError(
      operation,
      response.status,
      response.headers,
      ctx.now?.(),
      response.status === 401 && ctx.tokenCached === true,
    );
  }
  return response;
}

/** GETs the resource and proves it is the one this id names (and, for an object, this class). */
export async function verifyIdentity(
  ctx: GoogleWalletRestContext,
  resource: Resource,
  id: DerivedGoogleId,
  classId?: DerivedGoogleId,
): Promise<Record<string, unknown>> {
  const response = await request(ctx, resource, 'GET', id);
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new GoogleWalletError('invalid_response', `${resource} GET`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GoogleWalletError('invalid_response', `${resource} GET`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || (classId && typeof record.classId !== 'string')) {
    throw new GoogleWalletError('invalid_response', `${resource} GET`);
  }
  if (record.id !== id || (classId && record.classId !== classId)) {
    throw new GoogleWalletError('conflict', `${resource} identity`);
  }
  return record;
}

// A 409 is not success: confirm the existing resource's identity, then require PATCH success.
export async function upsert(
  ctx: GoogleWalletRestContext,
  resource: Resource,
  id: DerivedGoogleId,
  projection: Record<string, unknown>,
  classId?: DerivedGoogleId,
): Promise<GoogleUpsertResult> {
  if (knownResources.has(`${resource}/${id}`)) {
    try {
      await request(ctx, resource, 'PATCH', id, projection);
      return 'updated';
    } catch (error) {
      if (!(error instanceof GoogleWalletError) || error.code !== 'not_found') throw error;
      knownResources.delete(`${resource}/${id}`);
    }
  }
  try {
    await request(ctx, resource, 'POST', undefined, {
      ...projection,
      id,
      ...(classId ? { classId } : {}),
    });
    remember(resource, id);
    return 'created';
  } catch (error) {
    if (!(error instanceof GoogleWalletError) || error.code !== 'conflict') throw error;
  }
  await verifyIdentity(ctx, resource, id, classId);
  await request(ctx, resource, 'PATCH', id, projection);
  remember(resource, id);
  return 'updated';
}

// https://developers.google.com/wallet/reference/rest/v1/genericclass
export async function upsertGoogleGenericClass(
  ctx: GoogleWalletRestContext,
  scope: GoogleClassScope,
  projection: GoogleGenericProjection,
): Promise<GoogleUpsertResult> {
  const body = copyGoogleProjection(projection);
  const id = await googleClassId(ctx.account.issuerId, ctx.objectIdHmacKey, scope);
  return upsert(ctx, 'genericClass', id, body);
}

export async function patchGoogleGenericClass(
  ctx: GoogleWalletRestContext,
  scope: GoogleClassScope,
  projection: GoogleGenericProjection,
): Promise<void> {
  const body = copyGoogleProjection(projection);
  const id = await googleClassId(ctx.account.issuerId, ctx.objectIdHmacKey, scope);
  await request(ctx, 'genericClass', 'PATCH', id, body);
}

// https://developers.google.com/wallet/reference/rest/v1/genericobject
export async function upsertGoogleGenericObject(
  ctx: GoogleWalletRestContext,
  scope: GoogleObjectScope,
  projection: GoogleGenericProjection,
): Promise<GoogleUpsertResult> {
  const body = copyGoogleProjection(projection);
  const { classId, objectId } = await googleObjectIds(
    ctx.account.issuerId,
    ctx.objectIdHmacKey,
    scope,
  );
  return upsert(ctx, 'genericObject', objectId, body, classId);
}

export async function patchGoogleGenericObject(
  ctx: GoogleWalletRestContext,
  scope: GoogleObjectScope,
  projection: GoogleGenericProjection,
): Promise<void> {
  const body = copyGoogleProjection(projection);
  const { classId, objectId } = await googleObjectIds(
    ctx.account.issuerId,
    ctx.objectIdHmacKey,
    scope,
  );
  if (knownResources.has(`genericObject/${objectId}`)) {
    try {
      await request(ctx, 'genericObject', 'PATCH', objectId, body);
      return;
    } catch (error) {
      if (error instanceof GoogleWalletError && error.code === 'not_found')
        knownResources.delete(`genericObject/${objectId}`);
      throw error;
    }
  }
  await verifyIdentity(ctx, 'genericObject', objectId, classId);
  await request(ctx, 'genericObject', 'PATCH', objectId, body);
  remember('genericObject', objectId);
}

export async function inactivateGoogleGenericObject(
  ctx: GoogleWalletRestContext,
  scope: GoogleObjectScope,
): Promise<void> {
  const { classId, objectId } = await googleObjectIds(
    ctx.account.issuerId,
    ctx.objectIdHmacKey,
    scope,
  );
  await verifyIdentity(ctx, 'genericObject', objectId, classId);
  await request(ctx, 'genericObject', 'PATCH', objectId, { state: 'INACTIVE' });
}
