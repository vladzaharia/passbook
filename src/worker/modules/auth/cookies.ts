import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { NEXT_COOKIE, NEXT_COOKIE_MAX_AGE_S, NEXT_COOKIE_PATH } from '../../../shared/next.ts';
import { SESSION_COOKIE } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';

export const OIDC_COOKIE = '__Host-wallet_oidc';
export const MAGIC_COOKIE = '__Host-wallet_ml';

const BASE = { path: '/', secure: true, httpOnly: true, sameSite: 'Lax' } as const;

export function setSessionCookie(c: Context<AppBindings>, value: string, maxAgeSeconds: number) {
  setCookie(c, SESSION_COOKIE, value, { ...BASE, maxAge: maxAgeSeconds });
}

export function clearSessionCookie(c: Context<AppBindings>) {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
}

export function setBindingCookie(
  c: Context<AppBindings>,
  name: string,
  value: string,
  maxAgeSeconds: number,
) {
  setCookie(c, name, value, { ...BASE, maxAge: maxAgeSeconds });
}

export function clearCookie(c: Context<AppBindings>, name: string) {
  deleteCookie(c, name, { path: '/', secure: true });
}

/**
 * The next a switch keeps through Pocket ID's end-session (shared/next.ts). Only /login sees it;
 * script reads it there, so it is not HttpOnly. A sign-out without next drops an older one.
 */
export function setNextCookie(c: Context<AppBindings>, next: string | null) {
  if (!next) {
    deleteCookie(c, NEXT_COOKIE, { path: NEXT_COOKIE_PATH, secure: true });
    return;
  }
  setCookie(c, NEXT_COOKIE, next, {
    path: NEXT_COOKIE_PATH,
    secure: true,
    sameSite: 'Lax',
    maxAge: NEXT_COOKIE_MAX_AGE_S,
  });
}

/** Cookie value, or undefined when absent or implausibly long. */
export function readCookie(c: Context<AppBindings>, name: string): string | undefined {
  const value = getCookie(c, name);
  return value && value.length <= 256 ? value : undefined;
}

export { ipPrefix } from '../../platform/ip.ts';
