import {
  JoinLinkParamsSchema,
  JoinLinkQuerySchema,
  JoinLinkStateSchema,
  JoinLinkUpdateSchema,
} from '../../../shared/contracts/join.ts';
import { limitBody } from '../../platform/body-limit.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { authOf, requireTenantSession, svc } from '../passes/http.ts';
import { getJoinLinkState, rotateJoinLink, saveJoinLink } from './links.ts';

/** /api/v1/join-links: the link of a template in the console's mode. Browser sessions only, no API key. */
export const joinLinksRoutes = createRouter();
guard(joinLinksRoutes, requireTenantSession);
joinLinksRoutes.use('*', limitBody(16 * 1024));

const session = (c: Parameters<typeof authOf>[0]) => {
  const auth = authOf(c);
  if (auth.kind !== 'session') throw new UnauthenticatedError();
  return auth;
};

register(
  joinLinksRoutes,
  'join-links',
  {
    method: 'get',
    path: '/{templateId}',
    summary: "A template's join link, its readiness and today's count",
    params: JoinLinkParamsSchema,
    query: JoinLinkQuerySchema,
    response: JoinLinkStateSchema,
  },
  async (c) =>
    c.json(
      await getJoinLinkState(
        svc(c),
        session(c),
        c.req.valid('param').templateId,
        c.req.valid('query').orgId,
      ),
    ),
);

register(
  joinLinksRoutes,
  'join-links',
  {
    method: 'put',
    path: '/{templateId}',
    summary: 'Create a join link (revision 0) or change it',
    params: JoinLinkParamsSchema,
    query: JoinLinkQuerySchema,
    body: JoinLinkUpdateSchema,
    response: JoinLinkStateSchema,
  },
  async (c) =>
    c.json(
      await saveJoinLink(
        svc(c),
        session(c),
        c.req.valid('param').templateId,
        c.req.valid('query').orgId,
        c.req.valid('json'),
      ),
    ),
);

register(
  joinLinksRoutes,
  'join-links',
  {
    method: 'post',
    path: '/{templateId}/rotate',
    summary: 'Make a new link: the old token stops working',
    params: JoinLinkParamsSchema,
    query: JoinLinkQuerySchema,
    response: JoinLinkStateSchema,
  },
  async (c) =>
    c.json(
      await rotateJoinLink(
        svc(c),
        session(c),
        c.req.valid('param').templateId,
        c.req.valid('query').orgId,
      ),
    ),
);
