import {
  CapturedEmailDetailSchema,
  CapturedEmailListQuerySchema,
  CapturedEmailListSchema,
  IdParamSchema,
  SentToMeSchema,
} from '../../../shared/contracts/index.ts';
import { modeOf, requireAdmin } from '../../platform/auth.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { actorFor, authOf, svc } from '../passes/http.ts';
import { getCapturedEmail, listCapturedEmails, sendCapturedToMe } from './service.ts';

/** /api/v1/test-inbox: mail held back for test passes and bundles. Admins only. */
export const sandboxRoutes = createRouter();
guard(sandboxRoutes, requireAdmin);

register(
  sandboxRoutes,
  'sandbox',
  {
    method: 'get',
    path: '/',
    summary: 'List captured test emails, newest first',
    query: CapturedEmailListQuerySchema,
    response: CapturedEmailListSchema,
  },
  async (c) => {
    const q = c.req.valid('query');
    return c.json(await listCapturedEmails(svc(c), { ...q, mode: modeOf(authOf(c)) }));
  },
);

register(
  sandboxRoutes,
  'sandbox',
  {
    method: 'get',
    path: '/{id}',
    summary: 'One captured email with its HTML and text',
    params: IdParamSchema,
    response: CapturedEmailDetailSchema,
  },
  async (c) => c.json(await getCapturedEmail(svc(c), c.req.valid('param').id)),
);

/**
 * The email as a page for the Test inbox's iframe. It has its own policy so the email's inline
 * styles apply; `sandbox` and `default-src 'none'` keep scripts, forms and requests out. The app's
 * own policy stays strict.
 */
export const EMAIL_FRAME_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy':
    "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; frame-ancestors 'self'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN',
  'cache-control': 'no-store',
} as const;

register(
  sandboxRoutes,
  'sandbox',
  {
    method: 'get',
    path: '/{id}/html',
    summary: 'The captured email as HTML, for the inbox preview frame',
    params: IdParamSchema,
  },
  async (c) => {
    const { html } = await getCapturedEmail(svc(c), c.req.valid('param').id);
    return new Response(html, { headers: EMAIL_FRAME_HEADERS });
  },
);

register(
  sandboxRoutes,
  'sandbox',
  {
    method: 'post',
    path: '/{id}/send-to-me',
    summary: 'Send a captured email to your own verified address',
    params: IdParamSchema,
    response: SentToMeSchema,
  },
  async (c) => c.json(await sendCapturedToMe(svc(c), actorFor(c), c.req.valid('param').id)),
);
