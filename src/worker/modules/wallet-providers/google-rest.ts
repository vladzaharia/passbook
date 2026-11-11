import type { GoogleValidatedAccount } from './google-credentials.ts';
import { GoogleWalletError, googleFetch, googleHttpError } from './google-errors.ts';
import {
  type GoogleClassScope,
  type GoogleObjectScope,
  googleClassId,
  googleObjectIds,
} from './google-ids.ts';
import { isGoogleBearerToken } from './google-oauth.ts';
import { copyGoogleProjection, type GoogleGenericProjection } from './google-projection.ts';

const WALLET_API = 'https://walletobjects.googleapis.com/walletobjects/v1';

type Resource = 'genericClass' | 'genericObject';
export type GoogleUpsertResult = 'created' | 'updated';

export interface GoogleWalletRestContext {
  account: GoogleValidatedAccount;
  objectIdHmacKey: Uint8Array;
  accessToken: string;
  fetcher?: typeof fetch;
}

async function request(
  ctx: GoogleWalletRestContext,
  resource: Resource,
  method: 'GET' | 'POST' | 'PATCH',
  id?: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  if (!isGoogleBearerToken(ctx.accessToken)) throw new GoogleWalletError('invalid_input', 'rest');
  const operation = `${resource} ${method}`;
  const response = await googleFetch(
    ctx.fetcher ?? globalThis.fetch,
    `${WALLET_API}/${resource}${id ? `/${encodeURIComponent(id)}` : ''}`,
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
  if (!response.ok) throw googleHttpError(operation, response.status);
  return response;
}

async function verifyIdentity(
  ctx: GoogleWalletRestContext,
  resource: Resource,
  id: string,
  classId?: string,
): Promise<void> {
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
}

// A 409 is not success: confirm the existing resource's identity, then require PATCH success.
async function upsert(
  ctx: GoogleWalletRestContext,
  resource: Resource,
  id: string,
  projection: Record<string, unknown>,
  classId?: string,
): Promise<GoogleUpsertResult> {
  try {
    await request(ctx, resource, 'POST', undefined, {
      ...projection,
      id,
      ...(classId ? { classId } : {}),
    });
    return 'created';
  } catch (error) {
    if (!(error instanceof GoogleWalletError) || error.code !== 'conflict') throw error;
  }
  await verifyIdentity(ctx, resource, id, classId);
  await request(ctx, resource, 'PATCH', id, projection);
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
  await verifyIdentity(ctx, 'genericObject', objectId, classId);
  await request(ctx, 'genericObject', 'PATCH', objectId, body);
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
