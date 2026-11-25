import type { Context } from 'hono';
import { Hono } from 'hono';
import type { z } from 'zod';
import { limitBody } from '../../platform/body-limit.ts';
import type { AppBindings } from '../../platform/context.ts';
import { BadRequestError, NotFoundError } from '../../platform/errors.ts';
import { serviceContext } from '../../platform/service-context.ts';
import {
  countGroups,
  countUsers,
  deleteGroup,
  deleteUser,
  groupByGroupId,
  groupById,
  listGroups,
  listUsers,
  membersOf,
  setGroupMembers,
  setUserActive,
  upsertGroup,
  upsertUser,
  userById,
  userBySubject,
} from './repo-scim.ts';
import { scimAuth } from './scim-auth.ts';
import { membersRemoved, userDeactivated } from './scim-effects.ts';
import {
  groupResource,
  listResponse,
  PageQuery,
  pageOf,
  SCIM_BODY_BYTES,
  ScimGroupBody,
  ScimUserBody,
  scimJson,
  userResource,
} from './scim-wire.ts';

/**
 * Polaris ID's SCIM push (design 1 section 5.9), mounted at `/scim/v2`: list, create, replace and delete users and
 * groups with the bearer token. It is not in the OpenAPI document: only Polaris ID calls it. The mirror holds ids
 * and flags; see `scim-effects.ts` for the little it may do.
 */
export const scimRoutes = new Hono<AppBindings>();
scimRoutes.use('*', scimAuth);
scimRoutes.use('/Users/*', limitBody(SCIM_BODY_BYTES.user));
scimRoutes.use('/Groups/*', limitBody(SCIM_BODY_BYTES.group));

type C = Context<AppBindings>;

async function bodyOf<T extends z.ZodType>(c: C, schema: T): Promise<z.output<T>> {
  let json: unknown;
  try {
    json = JSON.parse(await c.req.text());
  } catch {
    throw new BadRequestError('The request is not valid JSON.', 'SCIM_INVALID');
  }
  const parsed = schema.safeParse(json);
  // The reason is the field paths only: a value from the body never goes into a message or a log.
  if (!parsed.success)
    throw new BadRequestError(
      `Invalid fields: ${[...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', ')}.`,
      'SCIM_INVALID',
    );
  return parsed.data;
}

const page = (c: C) => {
  const query = PageQuery.parse({
    startIndex: c.req.query('startIndex'),
    count: c.req.query('count'),
  });
  return { ...pageOf(query), startIndex: query.startIndex };
};

const empty = () =>
  new Response(null, { status: 204, headers: { 'cache-control': 'private, no-store' } });

scimRoutes.get('/Users', async (c) => {
  const { offset, limit, startIndex } = page(c);
  const db = c.env.DB;
  const rows = await listUsers(db, offset, limit);
  return scimJson(listResponse(rows.map(userResource), await countUsers(db), startIndex));
});

scimRoutes.get('/Users/:id', async (c) => {
  const row = await userById(c.env.DB, c.req.param('id'));
  if (!row || row.deleted_at !== null) throw new NotFoundError('No such user.');
  return scimJson(userResource(row));
});

scimRoutes.post('/Users', async (c) => {
  const ctx = serviceContext(c);
  const body = await bodyOf(c, ScimUserBody);
  const before = await userBySubject(ctx.env.DB, body.externalId);
  // The effect goes first: if it fails the mirror is unchanged and the next push finds the change again.
  if (!body.active && (!before || before.deleted_at !== null || before.active === 1))
    await userDeactivated(ctx, body.externalId, 'inactive');
  const row = await upsertUser(ctx.env.DB, {
    scimId: ctx.ids.id(),
    subject: body.externalId,
    active: body.active,
    now: ctx.clock.now(),
  });
  if (!row) throw new Error('SCIM user upsert returned no row');
  return scimJson(userResource(row), before ? 200 : 201);
});

scimRoutes.put('/Users/:id', async (c) => {
  const ctx = serviceContext(c);
  const before = await userById(ctx.env.DB, c.req.param('id'));
  if (!before || before.deleted_at !== null) throw new NotFoundError('No such user.');
  const body = await bodyOf(c, ScimUserBody);
  if (body.externalId !== before.subject)
    throw new BadRequestError('The user id cannot change.', 'SCIM_INVALID');
  if (!body.active && before.active === 1) await userDeactivated(ctx, before.subject, 'inactive');
  await setUserActive(ctx.env.DB, before.scim_id, body.active, ctx.clock.now());
  const row = await userById(ctx.env.DB, before.scim_id);
  if (!row) throw new NotFoundError('No such user.');
  return scimJson(userResource(row));
});

scimRoutes.delete('/Users/:id', async (c) => {
  const ctx = serviceContext(c);
  const row = await userById(ctx.env.DB, c.req.param('id'));
  if (!row || row.deleted_at !== null) throw new NotFoundError('No such user.');
  await userDeactivated(ctx, row.subject, 'deleted');
  await deleteUser(ctx.env.DB, row.scim_id, ctx.clock.now());
  return empty();
});

scimRoutes.get('/Groups', async (c) => {
  const { offset, limit, startIndex } = page(c);
  const db = c.env.DB;
  const rows = await listGroups(db, offset, limit);
  return scimJson(listResponse(rows.map(groupResource), await countGroups(db), startIndex));
});

scimRoutes.get('/Groups/:id', async (c) => {
  const row = await groupById(c.env.DB, c.req.param('id'));
  if (!row || row.deleted_at !== null) throw new NotFoundError('No such group.');
  return scimJson(groupResource(row));
});

const dropped = (before: readonly string[], after: readonly string[]) => {
  const keep = new Set(after);
  return before.filter((id) => !keep.has(id));
};

scimRoutes.post('/Groups', async (c) => {
  const ctx = serviceContext(c);
  const body = await bodyOf(c, ScimGroupBody);
  const members = [...new Set(body.members.map((m) => m.value))];
  const before = await groupByGroupId(ctx.env.DB, body.externalId);
  if (before && before.deleted_at === null)
    await membersRemoved(ctx, dropped(membersOf(before), members));
  const row = await upsertGroup(ctx.env.DB, {
    scimId: ctx.ids.id(),
    groupId: body.externalId,
    members,
    now: ctx.clock.now(),
  });
  if (!row) throw new Error('SCIM group upsert returned no row');
  return scimJson(groupResource(row), before ? 200 : 201);
});

scimRoutes.put('/Groups/:id', async (c) => {
  const ctx = serviceContext(c);
  const before = await groupById(ctx.env.DB, c.req.param('id'));
  if (!before || before.deleted_at !== null) throw new NotFoundError('No such group.');
  const body = await bodyOf(c, ScimGroupBody);
  if (body.externalId !== before.group_id)
    throw new BadRequestError('The group id cannot change.', 'SCIM_INVALID');
  const members = [...new Set(body.members.map((m) => m.value))];
  await membersRemoved(ctx, dropped(membersOf(before), members));
  await setGroupMembers(ctx.env.DB, before.scim_id, members, ctx.clock.now());
  const row = await groupById(ctx.env.DB, before.scim_id);
  if (!row) throw new NotFoundError('No such group.');
  return scimJson(groupResource(row));
});

scimRoutes.delete('/Groups/:id', async (c) => {
  const ctx = serviceContext(c);
  const row = await groupById(ctx.env.DB, c.req.param('id'));
  if (!row || row.deleted_at !== null) throw new NotFoundError('No such group.');
  await membersRemoved(ctx, membersOf(row));
  await deleteGroup(ctx.env.DB, row.scim_id, ctx.clock.now());
  return empty();
});
