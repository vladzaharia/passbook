import type { MockOidcUser } from '../../../../test/mock-oidc/index.ts';
import { ISSUER, type Jar, type TestHarness } from './test-support.ts';

export interface OidcSignInOptions {
  next?: string;
  /** Edits the authorize URL before the mock sees it. */
  tamper?: (url: URL) => void;
  /** Edits the callback URL before it reaches the app. */
  tamperCallback?: (url: URL) => void;
}

/** Drives start -> mock authorize -> callback and returns the callback response. */
export async function oidcSignIn(
  h: TestHarness,
  jar: Jar,
  user: MockOidcUser,
  opts: OidcSignInOptions = {},
) {
  h.oidc.addUser(user);
  const query = opts.next === undefined ? '' : `?next=${encodeURIComponent(opts.next)}`;
  const start = await h.call(`/auth/oidc/start${query}`, { cookies: jar });
  const loc = new URL(start.headers.get('location') ?? '');
  loc.searchParams.set('login_hint', user.sub);
  opts.tamper?.(loc);
  const authz = await h.oidc.handle(new Request(loc.toString().replace(ISSUER, 'http://mock')));
  const cb = new URL(authz.headers.get('location') ?? '');
  opts.tamperCallback?.(cb);
  const res = await h.call(`${cb.pathname}${cb.search}`, { cookies: jar });
  return { start, res, callback: cb };
}
