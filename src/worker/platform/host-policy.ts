/**
 * Which hosts answer. PUBLIC_BASE_URL's origin serves the app. A REDIRECT_HOSTS host (comma list)
 * answers every request, any path or method, with a 308 to the same path and query on the
 * canonical origin. Any other host is refused. index.ts turns this on; tests build the app
 * without it because they use several hosts.
 */
import { createMiddleware } from 'hono/factory';
import type { AppBindings } from './context.ts';
import type { AppEnv } from './env.ts';
import { AppError } from './errors.ts';

export type HostDecision =
  | { action: 'serve' }
  | { action: 'redirect'; location: string }
  | { action: 'refuse' };

type HostEnv = Pick<AppEnv, 'PUBLIC_BASE_URL'> & { REDIRECT_HOSTS?: string };

export function redirectHosts(env: HostEnv): string[] {
  return (env.REDIRECT_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

export function hostDecision(env: HostEnv, url: URL): HostDecision {
  const canonical = new URL(env.PUBLIC_BASE_URL);
  const moved: HostDecision = {
    action: 'redirect',
    location: `${canonical.origin}${url.pathname}${url.search}`,
  };
  // Same host over plain http: upgrade, so Secure cookies and HSTS apply.
  if (url.host === canonical.host)
    return url.protocol === canonical.protocol ? { action: 'serve' } : moved;
  return redirectHosts(env).includes(url.host) ? moved : { action: 'refuse' };
}

export const hostPolicy = createMiddleware<AppBindings>(async (c, next) => {
  const url = new URL(c.req.url);
  const decision = hostDecision(c.env, url);
  if (decision.action === 'serve') return next();
  if (decision.action === 'redirect') {
    // Uncached, so a rollback (or a second move) takes effect at once instead of looping.
    return new Response(null, {
      status: 308,
      headers: { location: decision.location, 'cache-control': 'no-store' },
    });
  }
  c.var.log.warn('host.refused', { code: 'HOST_UNKNOWN', host: url.host.slice(0, 255) });
  throw new AppError('HOST_UNKNOWN', 421, 'This host is not served here.');
});
