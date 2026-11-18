import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppBindings } from '../../platform/context.ts';
import { derivedHmacKey } from '../../platform/crypto.ts';
import { toBase64Url } from '../../platform/ids.ts';

/** One card per link per device per day: the cookie is a random value the server keeps only as a keyed digest. */
export const JOIN_COOKIE = '__Host-pb_join';
const DEVICE_TTL_S = 24 * 60 * 60;
const DEVICE_VALUE = /^[A-Za-z0-9_-]{43}$/;
const LABEL = 'join.device.v1';
const encoder = new TextEncoder();

/** The device value of a request, or undefined for none or a value this server never made. */
export function readDeviceCookie(c: Context<AppBindings>): string | undefined {
  const value = getCookie(c, JOIN_COOKIE);
  return value && DEVICE_VALUE.test(value) ? value : undefined;
}

export function setDeviceCookie(c: Context<AppBindings>, value: string): void {
  setCookie(c, JOIN_COOKIE, value, {
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: DEVICE_TTL_S,
  });
}

export function clearDeviceCookie(c: Context<AppBindings>): void {
  deleteCookie(c, JOIN_COOKIE, { path: '/', secure: true });
}

/** A 256-bit keyed digest (base64url): the form the ledger stores. Each part is length-prefixed, so none can run into the next. */
async function digest(env: object, ...parts: string[]): Promise<string> {
  const key = await derivedHmacKey(env, LABEL);
  const text = parts.map((p) => `${p.length}:${p}`).join('|');
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(text) as BufferSource);
  return toBase64Url(new Uint8Array(mac));
}

export const deviceKeyOf = (env: object, device: string) => digest(env, 'device', device);

/** The network the request came from, keyed per link. */
export const ipKeyOf = (env: object, linkId: string, prefix: string) =>
  digest(env, 'ip', linkId, prefix);

/** What one submit said: the same link, name and address make the same digest. */
export const fieldsHashOf = (env: object, linkId: string, name: string, email: string) =>
  digest(env, 'fields', linkId, name, email);
