import { CursorQuerySchema, OkSchema } from '../../../shared/contracts/common.ts';
import {
  CreateGroupMemberSchema,
  CreateGroupSchema,
  EnsureGroupSchema,
  GroupKeyParamSchema,
  GroupListSchema,
  GroupMemberListSchema,
  GroupMemberSchema,
  GroupResultSchema,
  GroupRuleInputSchema,
  GroupRuleListSchema,
  GroupRuleParamSchema,
  GroupRuleSchema,
  UpdateGroupSchema,
} from '../../../shared/contracts/idp-access.ts';
import { platformActorOf } from '../../platform/actor.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { STEP_UP_SECONDS } from '../../platform/sign-in-guard.ts';
import { idpIdempotent } from './idempotent.ts';
import { addMember, listMembers, removeMember } from './service-group-members.ts';
import { addRule, endRule, listRules } from './service-group-rules.ts';
import {
  createGroup,
  deleteGroup,
  ensureRoleGroup,
  listGroups,
  updateGroup,
} from './service-groups.ts';

const TAG = 'polaris groups';
const actorOf = (c: Parameters<typeof platformActorOf>[0]) =>
  platformActorOf(c, { scope: 'platform:groups' });
/** A platform admin or a Platform key. A person's writes also need a recent Polaris ID sign-in: the change reaches every app that trusts the group. */
const READ = { platform: 'platform:groups', key: true } as const;
const WRITE = {
  platform: 'platform:groups',
  key: true,
  signIn: 'oidc',
  stepUp: { maxAgeSec: STEP_UP_SECONDS },
} as const;

/** Mount at /api/v1/platform. */
export const idpGroupsRoutes = createRouter();

register(
  idpGroupsRoutes,
  TAG,
  {
    method: 'get',
    path: '/idp/groups',
    query: CursorQuerySchema,
    summary: 'List the Polaris ID groups PassBook manages',
    response: GroupListSchema,
    auth: READ,
  },
  async (c) => {
    platformActorOf(c);
    return c.json({ items: await listGroups(serviceContext(c)), nextCursor: null });
  },
);

register(
  idpGroupsRoutes,
  TAG,
  {
    method: 'post',
    path: '/idp/groups',
    summary: 'Create a custom Polaris ID group',
    body: CreateGroupSchema,
    response: GroupResultSchema,
    status: 201,
    auth: WRITE,
  },
  (c) => {
    const body = c.req.valid('json');
    return idpIdempotent(c, body, 201, (ctx) => createGroup(ctx, actorOf(c), body));
  },
);

register(
  idpGroupsRoutes,
  TAG,
  {
    method: 'post',
    path: '/idp/groups/ensure',
    summary: 'Create a configured role group in Polaris ID',
    body: EnsureGroupSchema,
    response: GroupResultSchema,
    status: 201,
    auth: WRITE,
  },
  (c) => {
    const body = c.req.valid('json');
    return idpIdempotent(c, body, 201, (ctx) => ensureRoleGroup(ctx, actorOf(c), body.role));
  },
);

register(
  idpGroupsRoutes,
  TAG,
  {
    method: 'patch',
    path: '/idp/groups/{key}',
    summary: "Rename a group's display name",
    params: GroupKeyParamSchema,
    body: UpdateGroupSchema,
    response: GroupResultSchema,
    auth: WRITE,
  },
  (c) => {
    const body = c.req.valid('json');
    const { key } = c.req.valid('param');
    return idpIdempotent(c, body, 200, (ctx) =>
      updateGroup(ctx, actorOf(c), key, body.friendlyName),
    );
  },
);

register(
  idpGroupsRoutes,
  TAG,
  {
    method: 'delete',
    path: '/idp/groups/{key}',
    summary: 'Delete an empty custom group PassBook created',
    params: GroupKeyParamSchema,
    response: GroupResultSchema,
    auth: WRITE,
  },
  (c) => {
    const { key } = c.req.valid('param');
    return idpIdempotent(c, null, 200, (ctx) => deleteGroup(ctx, actorOf(c), key));
  },
);

register(
  idpGroupsRoutes,
  TAG,
  {
    method: 'get',
    path: '/idp/groups/{key}/rules',
    query: CursorQuerySchema,
    summary: "List a group's org rules",
    params: GroupKeyParamSchema,
    response: GroupRuleListSchema,
    auth: READ,
  },
  async (c) => {
    platformActorOf(c);
    return c.json({
      items: await listRules(serviceContext(c), c.req.valid('param').key),
      nextCursor: null,
    });
  },
);

register(
  idpGroupsRoutes,
  TAG,
  {
    method: 'post',
    path: '/idp/groups/{key}/rules',
    summary: 'Add an org rule: members of the org join the group',
    params: GroupKeyParamSchema,
    body: GroupRuleInputSchema,
    response: GroupRuleSchema,
    status: 201,
    auth: WRITE,
  },
  (c) => {
    const body = c.req.valid('json');
    const { key } = c.req.valid('param');
    return idpIdempotent(c, body, 201, (ctx) => addRule(ctx, actorOf(c), key, body));
  },
);

register(
  idpGroupsRoutes,
  TAG,
  {
    method: 'delete',
    path: '/idp/groups/{key}/rules/{id}',
    summary: 'End an org rule',
    params: GroupRuleParamSchema,
    response: OkSchema,
    auth: WRITE,
  },
  (c) => {
    const { key, id } = c.req.valid('param');
    return idpIdempotent(c, null, 200, async (ctx) => {
      await endRule(ctx, actorOf(c), key, id);
      return { ok: true as const };
    });
  },
);

register(
  idpGroupsRoutes,
  TAG,
  {
    method: 'get',
    path: '/idp/groups/{key}/members',
    query: CursorQuerySchema,
    summary: "List a group's manual members",
    params: GroupKeyParamSchema,
    response: GroupMemberListSchema,
    auth: READ,
  },
  async (c) => {
    platformActorOf(c);
    return c.json({
      items: await listMembers(serviceContext(c), c.req.valid('param').key),
      nextCursor: null,
    });
  },
);

register(
  idpGroupsRoutes,
  TAG,
  {
    method: 'post',
    path: '/idp/groups/{key}/members',
    summary: 'Add a manual member, by user or Polaris ID subject',
    params: GroupKeyParamSchema,
    body: CreateGroupMemberSchema,
    response: GroupMemberSchema,
    status: 201,
    auth: WRITE,
  },
  (c) => {
    const body = c.req.valid('json');
    const { key } = c.req.valid('param');
    return idpIdempotent(c, body, 201, (ctx) => addMember(ctx, actorOf(c), key, body));
  },
);

register(
  idpGroupsRoutes,
  TAG,
  {
    method: 'delete',
    path: '/idp/groups/{key}/members/{id}',
    summary: 'Remove a manual member',
    params: GroupRuleParamSchema,
    response: OkSchema,
    auth: WRITE,
  },
  (c) => {
    const { key, id } = c.req.valid('param');
    return idpIdempotent(c, null, 200, async (ctx) => {
      await removeMember(ctx, actorOf(c), key, id);
      return { ok: true as const };
    });
  },
);
