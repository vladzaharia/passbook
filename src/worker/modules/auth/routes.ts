import {
  MagicLinkConsumeSchema,
  MagicLinkRequestSchema,
  OidcStartQuerySchema,
  OkSchema,
  SessionResponseSchema,
} from '../../../shared/contracts/index.ts';
import { sameOriginOnly } from '../../platform/csrf.ts';
import { createRouter, stub } from '../../platform/openapi.ts';

/** /auth */
export const authRoutes = createRouter();
authRoutes.use('/magic/*', sameOriginOnly);
authRoutes.use('/logout', sameOriginOnly);
stub(authRoutes, 'auth', {
  method: 'get',
  path: '/oidc/start',
  summary: 'Start Pocket ID sign-in',
  query: OidcStartQuerySchema,
  status: 302,
});
stub(authRoutes, 'auth', {
  method: 'get',
  path: '/oidc/callback',
  summary: 'Pocket ID callback',
  status: 302,
});
stub(authRoutes, 'auth', {
  method: 'post',
  path: '/magic/request',
  summary: 'Request a magic link (always 202)',
  body: MagicLinkRequestSchema,
  status: 202,
  response: OkSchema,
});
stub(authRoutes, 'auth', {
  method: 'get',
  path: '/magic',
  summary: 'Confirm page for a magic link (HTML)',
});
stub(authRoutes, 'auth', {
  method: 'post',
  path: '/magic/consume',
  summary: 'Consume a magic link or code',
  body: MagicLinkConsumeSchema,
  status: 302,
});
stub(authRoutes, 'auth', { method: 'post', path: '/logout', summary: 'Sign out', status: 302 });

/** /api/v1/session */
export const sessionRoutes = createRouter();
stub(sessionRoutes, 'session', {
  method: 'get',
  path: '/',
  summary: 'Current session, roles and CSRF token',
  response: SessionResponseSchema,
});
