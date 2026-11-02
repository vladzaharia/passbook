import {
  MagicLinkRequestSchema,
  OidcStartQuerySchema,
  OkSchema,
  SessionResponseSchema,
} from '../../../shared/contracts/index.ts';
import { limitBody } from '../../platform/body-limit.ts';
import { sameOriginOnly } from '../../platform/csrf.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { breakglassForm, breakglassSignIn } from './breakglass-handlers.ts';
import { confirmMagic, consumeMagic, requestMagic } from './magic-handlers.ts';
import { callbackOidc, noAccess, startOidc } from './oidc-handlers.ts';
import { getSession, logout } from './session-handlers.ts';

/** /auth */
export const authRoutes = createRouter();
authRoutes.use('/magic/*', sameOriginOnly);
authRoutes.use('/logout', sameOriginOnly);
authRoutes.use('/magic/*', limitBody(16 * 1024));
authRoutes.use('/breakglass', sameOriginOnly);
authRoutes.use('/breakglass', limitBody(4 * 1024));
register(
  authRoutes,
  'auth',
  {
    method: 'get',
    path: '/oidc/start',
    summary: 'Start Pocket ID sign-in',
    query: OidcStartQuerySchema,
    status: 302,
  },
  startOidc,
);
register(
  authRoutes,
  'auth',
  { method: 'get', path: '/oidc/callback', summary: 'Pocket ID callback', status: 302 },
  callbackOidc,
);
register(
  authRoutes,
  'auth',
  { method: 'get', path: '/no-access', summary: 'No access page for a Polaris ID (HTML)' },
  noAccess,
);
register(
  authRoutes,
  'auth',
  {
    method: 'post',
    path: '/magic/request',
    summary: 'Request a magic link (always 202)',
    body: MagicLinkRequestSchema,
    status: 202,
    response: OkSchema,
  },
  requestMagic,
);
register(
  authRoutes,
  'auth',
  { method: 'get', path: '/magic', summary: 'Confirm page for a magic link (HTML)' },
  confirmMagic,
);
// No `body` in the spec: the confirm page posts a form, the login page posts JSON.
register(
  authRoutes,
  'auth',
  { method: 'post', path: '/magic/consume', summary: 'Consume a magic link or code', status: 302 },
  consumeMagic,
);
register(
  authRoutes,
  'auth',
  { method: 'post', path: '/logout', summary: 'Sign out', status: 302 },
  logout,
);

register(
  authRoutes,
  'auth',
  { method: 'get', path: '/breakglass', summary: 'Break-glass admin sign-in form (HTML)' },
  breakglassForm,
);
register(
  authRoutes,
  'auth',
  { method: 'post', path: '/breakglass', summary: 'Break-glass admin sign-in', status: 302 },
  breakglassSignIn,
);

/** /api/v1/session */
export const sessionRoutes = createRouter();
register(
  sessionRoutes,
  'session',
  {
    method: 'get',
    path: '/',
    summary: 'Current session, roles and CSRF token',
    response: SessionResponseSchema,
  },
  async (c: Parameters<typeof getSession>[0]) => c.json(await getSession(c)),
);
