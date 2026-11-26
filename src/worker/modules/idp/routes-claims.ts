import { IdParamSchema } from '../../../shared/contracts/common.ts';
import {
  ClaimsResultSchema,
  ClaimsViewSchema,
  GroupKeyParamSchema,
  UpdateClaimsSchema,
} from '../../../shared/contracts/idp-access.ts';
import { platformActorOf } from '../../platform/actor.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { STEP_UP_SECONDS } from '../../platform/sign-in-guard.ts';
import { groupClaims, updateGroupClaims, updateUserClaims, userClaims } from './service-claims.ts';

const TAG = 'polaris claims';
/** Claims reach every app that signs in with Polaris ID: a platform admin signed in with Polaris ID recently (no break-glass), or a Platform key. A key never reaches a platform admin's claims, and reads them only with platform:claims. */
const AUTH = {
  platform: 'platform:claims',
  key: true,
  signIn: 'oidc',
  stepUp: { maxAgeSec: STEP_UP_SECONDS },
} as const;

const noStore = (router: ReturnType<typeof createRouter>) =>
  router.use('*', async (c, next) => {
    await next();
    c.header('cache-control', 'no-store');
  });

/** Mount at /api/v1/users, before `usersRoutes`: the paths are `/{id}/claims`. */
export const userClaimsRoutes = createRouter();
noStore(userClaimsRoutes);

register(
  userClaimsRoutes,
  TAG,
  {
    method: 'get',
    path: '/{id}/claims',
    summary: "Read a user's Polaris ID claims (the ones PassBook manages)",
    params: IdParamSchema,
    response: ClaimsViewSchema,
    auth: AUTH,
  },
  async (c) =>
    c.json(
      await userClaims(
        serviceContext(c),
        platformActorOf(c, { scope: 'platform:claims' }),
        c.req.valid('param').id,
      ),
    ),
);

register(
  userClaimsRoutes,
  TAG,
  {
    method: 'patch',
    path: '/{id}/claims',
    summary: "Set or remove a user's Polaris ID claims",
    params: IdParamSchema,
    body: UpdateClaimsSchema,
    response: ClaimsResultSchema,
    auth: AUTH,
  },
  async (c) =>
    c.json(
      await updateUserClaims(
        serviceContext(c),
        platformActorOf(c, { scope: 'platform:claims' }),
        c.req.valid('param').id,
        c.req.valid('json'),
      ),
    ),
);

/** Mount at /api/v1/platform. */
export const groupClaimsRoutes = createRouter();
noStore(groupClaimsRoutes);

register(
  groupClaimsRoutes,
  TAG,
  {
    method: 'get',
    path: '/idp/groups/{key}/claims',
    summary: "Read a Polaris ID group's claims (the ones PassBook manages)",
    params: GroupKeyParamSchema,
    response: ClaimsViewSchema,
    auth: AUTH,
  },
  async (c) =>
    c.json(
      await groupClaims(
        serviceContext(c),
        platformActorOf(c, { scope: 'platform:claims' }),
        c.req.valid('param').key,
      ),
    ),
);

register(
  groupClaimsRoutes,
  TAG,
  {
    method: 'patch',
    path: '/idp/groups/{key}/claims',
    summary: "Set or remove a Polaris ID group's claims",
    params: GroupKeyParamSchema,
    body: UpdateClaimsSchema,
    response: ClaimsResultSchema,
    auth: AUTH,
  },
  async (c) =>
    c.json(
      await updateGroupClaims(
        serviceContext(c),
        platformActorOf(c, { scope: 'platform:claims' }),
        c.req.valid('param').key,
        c.req.valid('json'),
      ),
    ),
);
