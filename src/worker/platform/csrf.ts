import type { Context, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AuthContext } from './auth.ts';
import type { AppBindings } from './context.ts';
import { ForbiddenError } from './errors.ts';
import { safeEqual } from './ids.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const CSRF_HEADER = 'x-csrf-token';

function sameOrigin(c: Context): boolean {
  const site = c.req.header('sec-fetch-site');
  if (site) return site === 'same-origin';
  const origin = c.req.header('origin');
  return origin !== undefined && origin === new URL(c.req.url).origin;
}

/** Origin / Sec-Fetch-Site check only. For unauthenticated POSTs such as /auth/magic/request. */
export const sameOriginOnly: MiddlewareHandler<AppBindings> = createMiddleware(async (c, next) => {
  if (!SAFE_METHODS.has(c.req.method) && !sameOrigin(c)) {
    throw new ForbiddenError('Cross-origin requests are not allowed.', 'CSRF_ORIGIN');
  }
  await next();
});

/** Same-origin plus X-CSRF-Token equal to the session's secret. Applies to cookie sessions only. */
export async function csrfGuard(c: Context<AppBindings>, auth: AuthContext): Promise<void> {
  if (SAFE_METHODS.has(c.req.method) || auth.kind !== 'session') return;
  if (!sameOrigin(c))
    throw new ForbiddenError('Cross-origin requests are not allowed.', 'CSRF_ORIGIN');
  const token = c.req.header(CSRF_HEADER);
  if (!token || !(await safeEqual(token, auth.csrfSecret))) {
    throw new ForbiddenError('Reload the page and try again.', 'CSRF_TOKEN');
  }
}
