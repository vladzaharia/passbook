import {
  CapturedEmailDetailQuerySchema,
  CapturedEmailDetailSchema,
  CapturedEmailFrameQuerySchema,
  CapturedEmailListQuerySchema,
  CapturedEmailListSchema,
  CapturedEmailScopeQuerySchema,
  IdParamSchema,
  SentToMeSchema,
} from '../../../shared/contracts/index.ts';
import { modeOf } from '../../platform/auth.ts';
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { declareKeyAccess } from '../../platform/openapi-security.ts';
import {
  authOf,
  type C,
  orgIdOf,
  requireTenantSessionOrApiKey,
  svc,
  tenantAuthorityOf,
} from '../passes/http.ts';
import { getCapturedEmail, listCapturedEmails, sendCapturedToMe } from './service.ts';

/** /api/v1/test-inbox: Test mail held back for members of the selected organization. */
export const sandboxRoutes = createRouter();
guard(
  sandboxRoutes,
  // Keys read the list and one message; the preview frame and send-to-me are session-only.
  declareKeyAccess(requireTenantSessionOrApiKey(['passes:read']), {
    read: ['passes:read'],
    only: /^\/api\/v1\/test-inbox(\/\{id\})?$/,
  }),
);

/** A Test key reads its own organization's Test inbox and nothing else; Live and platform keys are refused. */
async function keyInboxAuthority(
  c: C,
  auth: Extract<ReturnType<typeof authOf>, { kind: 'api_key' }>,
  orgId: string,
  capability: 'passes:read' | 'passes:operate',
  mode: 'live' | 'test',
) {
  if (capability !== 'passes:read' || auth.mode !== 'test' || mode !== 'test')
    throw new ForbiddenError('Reading the test inbox needs a test key.', 'TEST_KEY_REQUIRED');
  if (auth.orgId !== orgId) throw new ForbiddenError();
  return tenantAuthorityOf(svc(c), auth, orgId, capability);
}

/** Who reads the list or one message: a session as before, or a Test key of the same organization. */
function readerAuthority(c: C, orgId: string, mode: 'live' | 'test', hide: boolean) {
  const auth = authOf(c);
  if (auth.kind === 'api_key') return keyInboxAuthority(c, auth, orgId, 'passes:read', mode);
  return inboxAuthority(c, orgId, 'passes:read', mode, hide);
}

async function inboxAuthority(
  c: C,
  orgId: string,
  capability: 'passes:read' | 'passes:operate',
  mode: 'live' | 'test',
  hide: boolean,
) {
  const auth = authOf(c);
  if (auth.kind === 'api_key')
    throw new ForbiddenError('Use a signed-in session.', 'SESSION_REQUIRED');
  if (auth.kind !== 'session') throw new UnauthenticatedError();
  if (hide && mode !== 'test')
    throw new NotFoundError('Email not found.', 'CAPTURED_EMAIL_NOT_FOUND');
  try {
    const authority = await tenantAuthorityOf(svc(c), { ...auth, mode }, orgId, capability);
    if (authority.kind !== 'session') throw new ForbiddenError();
    return authority;
  } catch (error) {
    if (hide && (error instanceof ForbiddenError || error instanceof NotFoundError))
      throw new NotFoundError('Email not found.', 'CAPTURED_EMAIL_NOT_FOUND');
    throw error;
  }
}

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
    const mode = modeOf(authOf(c));
    c.header('cache-control', 'no-store');
    try {
      const orgId = orgIdOf(authOf(c), q.orgId);
      const authority = await readerAuthority(c, orgId, mode, false);
      return c.json(await listCapturedEmails(svc(c), { ...q, orgId, mode }, authority));
    } catch (error) {
      if (error instanceof ForbiddenError && authOf(c).kind === 'session')
        return c.json({ items: [], nextCursor: null });
      throw error;
    }
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
    query: CapturedEmailDetailQuerySchema,
    response: CapturedEmailDetailSchema,
  },
  async (c) => {
    const q = c.req.valid('query');
    const orgId = orgIdOf(authOf(c), q.orgId);
    const authority = await readerAuthority(c, orgId, q.mode ?? modeOf(authOf(c)), true);
    const email = await getCapturedEmail(svc(c), c.req.valid('param').id, authority);
    c.header('cache-control', 'no-store');
    return c.json(email);
  },
);

/**
 * The email as a page for the Test inbox's iframe. It has its own policy so the email's inline
 * styles apply; `sandbox` and `default-src 'none'` keep scripts, forms and requests out, and `img-src`
 * allows only inline images so opening a message never reveals the viewer to the template author. The app's
 * own policy stays strict.
 */
export const EMAIL_FRAME_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy':
    "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'",
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
    query: CapturedEmailFrameQuerySchema,
  },
  async (c) => {
    const q = c.req.valid('query');
    const authority = await inboxAuthority(c, q.orgId, 'passes:read', q.mode, true);
    const { html } = await getCapturedEmail(svc(c), c.req.valid('param').id, authority);
    return new Response(html, { headers: EMAIL_FRAME_HEADERS });
  },
);

register(
  sandboxRoutes,
  'sandbox',
  {
    method: 'post',
    path: '/{id}/send-to-me',
    summary: 'Send a captured email once to your own verified address',
    params: IdParamSchema,
    query: CapturedEmailScopeQuerySchema,
    response: SentToMeSchema,
  },
  async (c) => {
    const q = c.req.valid('query');
    const authority = await inboxAuthority(c, q.orgId, 'passes:operate', modeOf(authOf(c)), true);
    const result = await sendCapturedToMe(svc(c), authority, c.req.valid('param').id);
    c.header('cache-control', 'no-store');
    return c.json(result);
  },
);
