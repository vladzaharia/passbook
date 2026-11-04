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

/**
 * The message as HTML for the admin's preview frame. The frame is sandboxed and this response
 * carries its own policy: inline styles (email is styled inline) and same-origin or data images,
 * no script, no fetch, no framing from anywhere but the admin itself.
 */
const PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; sandbox; frame-ancestors 'self'";

sandboxRoutes.get('/:id/html', async (c) => {
  const email = await getCapturedEmail(svc(c), c.req.param('id'));
  return c.html(email.html, 200, {
    'content-security-policy': PREVIEW_CSP,
    'x-frame-options': 'SAMEORIGIN',
    'cache-control': 'no-store',
  });
});
