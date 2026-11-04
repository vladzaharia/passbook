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
