import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
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

/** Cookie value, or undefined when absent or implausibly long. */
export function readCookie(c: Context<AppBindings>, name: string): string | undefined {
  const value = getCookie(c, name);
  return value && value.length <= 256 ? value : undefined;
}

/** v4 /24, v6 /48: enough for audit and session lists without storing full addresses. */
export function ipPrefix(ip: string | undefined): string | null {
  if (!ip || ip === 'unknown') return null;
  if (ip.includes(':')) return `${ip.split(':').slice(0, 3).join(':')}::/48`;
  const parts = ip.split('.');
  return parts.length === 4 ? `${parts.slice(0, 3).join('.')}.0/24` : null;
}
