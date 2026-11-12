import { createRoute } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { z } from 'zod';
import { PKPASSES_CONTENT_TYPE } from '../../../passkit/index.ts';
import {
  AddEmailRequestSchema,
  IdParamSchema,
  MY_PASSES_BUNDLE_PARTS_HEADER,
  MyBundleQuerySchema,
  MyEmailListSchema,
  MyEmailParamSchema,
  MyPassListSchema,
  MyPassSchema,
  MySessionListSchema,
  OkSchema,
  PageQuerySchema,
  ProblemSchema,
  RefreshResponseSchema,
  RemovePassResponseSchema,
} from '../../../shared/contracts/index.ts';
import { currentUserId, requireSession } from '../../platform/auth.ts';
import { limitBody } from '../../platform/body-limit.ts';
import type { AppBindings } from '../../platform/context.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { requestTheme } from '../../ssr/head.ts';
import { PRESENTATION_HEADERS, renderPresentationPage } from '../../ssr/presentation-page.tsx';
import { clearSessionCookie } from '../auth/cookies.ts';
import { assertPassSnapshot } from '../public/snapshot.ts';
import { myPassesBundle } from './bundle.ts';
import { assertOwnerPass, presentationForOwner } from './presentation.ts';
import { getMyPass, getMyRemoval, listMyPasses, refreshMyPass, removeMyPass } from './service.ts';
import {
  addMyEmail,
  listMyEmails,
  listMySessions,
  makeMyEmailPrimary,
  removeMyEmail,
  revokeAllMySessions,
  revokeMySession,
} from './service-account.ts';

type C = Context<AppBindings>;
const sessionId = (c: C) => (c.var.auth?.kind === 'session' ? c.var.auth.sessionId : '');

export const meRoutes = createRouter();
guard(meRoutes, requireSession);
meRoutes.use('*', limitBody(64 * 1024));

register(
  meRoutes,
  'me',
  {
    method: 'get',
    path: '/passes',
    summary: 'My passes',
    query: PageQuerySchema,
    response: MyPassListSchema,
  },
  async (c) =>
    c.json(await listMyPasses(serviceContext(c), currentUserId(c), c.req.valid('query'))),
);
register(
  meRoutes,
  'me',
  {
    method: 'get',
    path: '/passes.pkpasses',
    summary: 'All my active passes as .pkpasses bundles (10 per part)',
    query: MyBundleQuerySchema,
  },
  async (c) => {
    const { part, snapshot } = c.req.valid('query');
    const bundle = await myPassesBundle(serviceContext(c), currentUserId(c), part, snapshot);
    return new Response(bundle.body, {
      headers: {
        'content-type': PKPASSES_CONTENT_TYPE,
        'content-disposition': `attachment; filename="passes-${part}.pkpasses"`,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        [MY_PASSES_BUNDLE_PARTS_HEADER]: String(bundle.parts),
      },
    });
  },
);
register(
  meRoutes,
  'me',
  {
    method: 'get',
    path: '/passes/{id}',
    summary: 'One of my passes',
    params: IdParamSchema,
    response: MyPassSchema,
  },
  async (c) =>
    c.json(await getMyPass(serviceContext(c), currentUserId(c), c.req.valid('param').id)),
);
register(
  meRoutes,
  'me',
  {
    method: 'get',
    path: '/passes/{id}/barcode',
    summary: 'Present one of my passes',
    params: IdParamSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const id = c.req.valid('param').id;
    const { model, snapshot } = await presentationForOwner(ctx, currentUserId(c), id);
    const html = renderPresentationPage({
      ...model,
      backHref: `/passes/${id}`,
      nonce: c.var.nonce,
      theme: requestTheme(c),
    });
    await assertPassSnapshot(ctx, snapshot);
    await assertOwnerPass(ctx, currentUserId(c), snapshot.pass);
    return new Response(html, { headers: PRESENTATION_HEADERS });
  },
);
register(
  meRoutes,
  'me',
  {
    method: 'post',
    path: '/passes/{id}/refresh',
    summary: 'Force refresh (3/min per pass)',
    params: IdParamSchema,
    status: 202,
    response: RefreshResponseSchema,
  },
  async (c) =>
    c.json(await refreshMyPass(serviceContext(c), currentUserId(c), c.req.valid('param').id), 202),
);
meRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/passes/{id}',
    summary: 'Remove from my passes (blocks re-attach)',
    tags: ['me'],
    request: { params: IdParamSchema },
    responses: {
      200: {
        description: 'Removal completed',
        content: { 'application/json': { schema: RemovePassResponseSchema } },
      },
      202: {
        description: 'Removal pending wallet credential retirement',
        content: { 'application/json': { schema: RemovePassResponseSchema } },
      },
      default: {
        description: 'Error',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const result = await removeMyPass(
      serviceContext(c),
      currentUserId(c),
      sessionId(c),
      c.req.valid('param').id,
    );
    return result.state === 'pending' ? c.json(result, 202) : c.json(result, 200);
  },
);
register(
  meRoutes,
  'me',
  {
    method: 'get',
    path: '/pass-removals/{id}',
    summary: 'Status of my pass removal',
    params: IdParamSchema,
    response: RemovePassResponseSchema,
  },
  async (c) =>
    c.json(await getMyRemoval(serviceContext(c), currentUserId(c), c.req.valid('param').id)),
);
register(
  meRoutes,
  'me',
  { method: 'get', path: '/emails', summary: 'My emails', response: MyEmailListSchema },
  async (c: C) => c.json(await listMyEmails(serviceContext(c), currentUserId(c))),
);
register(
  meRoutes,
  'me',
  {
    method: 'post',
    path: '/emails',
    summary: 'Add an email and send a verification link',
    body: AddEmailRequestSchema,
    status: 202,
    response: OkSchema,
  },
  async (c) => {
    const { email } = c.req.valid('json');
    return c.json(await addMyEmail(serviceContext(c), currentUserId(c), email), 202);
  },
);
register(
  meRoutes,
  'me',
  {
    method: 'delete',
    path: '/emails/{email}',
    summary: 'Remove an email',
    params: z.object({ email: z.string() }),
    response: MyEmailListSchema,
  },
  async (c) =>
    c.json(await removeMyEmail(serviceContext(c), currentUserId(c), c.req.valid('param').email)),
);
register(
  meRoutes,
  'me',
  {
    method: 'post',
    path: '/emails/{email}/primary',
    summary: 'Make a verified email the primary (sign-in emails go there)',
    params: MyEmailParamSchema,
    response: MyEmailListSchema,
  },
  async (c) =>
    c.json(
      await makeMyEmailPrimary(serviceContext(c), currentUserId(c), c.req.valid('param').email),
    ),
);
register(
  meRoutes,
  'me',
  { method: 'get', path: '/sessions', summary: 'My sessions', response: MySessionListSchema },
  async (c: C) => c.json(await listMySessions(serviceContext(c), currentUserId(c), sessionId(c))),
);
register(
  meRoutes,
  'me',
  {
    method: 'post',
    path: '/sessions/revoke-all',
    summary: 'Sign out everywhere',
    response: OkSchema,
  },
  async (c) => {
    const result = await revokeAllMySessions(serviceContext(c), currentUserId(c));
    clearSessionCookie(c);
    return c.json(result);
  },
);
register(
  meRoutes,
  'me',
  {
    method: 'delete',
    path: '/sessions/{id}',
    summary: 'Revoke one of my sessions',
    params: IdParamSchema,
    response: OkSchema,
  },
  async (c) => {
    const result = await revokeMySession(
      serviceContext(c),
      currentUserId(c),
      c.req.valid('param').id,
    );
    if (c.req.valid('param').id === sessionId(c)) clearSessionCookie(c);
    return c.json(result);
  },
);
