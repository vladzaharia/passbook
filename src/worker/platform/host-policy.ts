/**
 * Which hosts answer. PUBLIC_BASE_URL's origin serves the app. A REDIRECT_HOSTS host (comma list)
 * answers every request, any path or method, with a 308 to the same path and query on the
 * canonical origin, except /wallet/v1/*: Wallet may not follow a redirect, and passes issued under
 * the old webServiceURL must keep updating, so the app serves it. A DEVELOPERS_HOSTS host does the same into /developers (its root is the portal's
 * home, so developers.passbook.mobile/reference/passes lands on /developers/reference/passes). Any
 * other host is refused. index.ts turns this on; tests build the app
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

type HostEnv = Pick<AppEnv, 'PUBLIC_BASE_URL'> & {
  REDIRECT_HOSTS?: string;
  DEVELOPERS_HOSTS?: string;
};

const hostList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);

export const redirectHosts = (env: HostEnv): string[] => hostList(env.REDIRECT_HOSTS);
const developersHosts = (env: HostEnv): string[] => hostList(env.DEVELOPERS_HOSTS);

/** The portal path a developers-host path maps to: the root is the home page. */
const portalPath = (pathname: string) =>
  pathname === '/'
    ? '/developers'
    : /^\/developers(\/|$)/.test(pathname)
      ? pathname
      : `/developers${pathname}`;

export function hostDecision(env: HostEnv, url: URL): HostDecision {
  const canonical = new URL(env.PUBLIC_BASE_URL);
  const moved: HostDecision = {
    action: 'redirect',
    location: `${canonical.origin}${url.pathname}${url.search}`,
  };
  // Same host over plain http: upgrade, so Secure cookies and HSTS apply.
  if (url.host === canonical.host)
    return url.protocol === canonical.protocol ? { action: 'serve' } : moved;
  if (developersHosts(env).includes(url.host)) {
    return {
      action: 'redirect',
      location: `${canonical.origin}${portalPath(url.pathname)}${url.search}`,
    };
  }
  if (!redirectHosts(env).includes(url.host)) return { action: 'refuse' };
  return /^\/wallet\/v1(\/|$)/.test(url.pathname) ? { action: 'serve' } : moved;
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
