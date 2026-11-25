import { z } from 'zod';
import type { DirectoryGroup, DirectoryUser } from './repo-scim.ts';
import { membersOf } from './repo-scim.ts';

const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const SCIM_GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const SCIM_CONTENT_TYPE = 'application/scim+json; charset=utf-8';

/** Polaris ID's user and group ids, and our own SCIM ids. */
export const ScimId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** Members one group may carry. A body that gets past this is not a directory this app serves. */
export const MAX_MEMBERS = 5000;

/**
 * What the receiver reads of a pushed user: the id (our subject) and whether it is active. The name, display name
 * and address in the body are never read, so they cannot be stored or logged; unknown keys are dropped.
 */
export const ScimUserBody = z.object({ externalId: ScimId, active: z.boolean().default(true) });

/** What it reads of a pushed group: its id and the SCIM ids of its members. The display name is dropped. */
export const ScimGroupBody = z.object({
  externalId: ScimId,
  members: z
    .array(z.object({ value: ScimId }))
    .max(MAX_MEMBERS)
    .default([]),
});

/** Body caps in bytes: a user is two fields, a group carries up to `MAX_MEMBERS` ids (the router's 256 KB default). */
export const SCIM_BODY_BYTES = { user: 16 * 1024, group: 256 * 1024 };

/** Largest page `count` may ask for (Polaris ID asks for 1000). */
export const MAX_PAGE = 1000;
/** A group carries up to `MAX_MEMBERS` ids, so its pages are smaller: a page stays within the Worker's memory. */
export const MAX_GROUP_PAGE = 100;

export const PageQuery = z.object({
  startIndex: z.coerce.number().int().catch(1),
  count: z.coerce.number().int().catch(100),
});

export function pageOf(
  query: { startIndex: number; count: number },
  max = MAX_PAGE,
): {
  offset: number;
  limit: number;
} {
  return {
    offset: Math.max(query.startIndex, 1) - 1,
    limit: Math.min(Math.max(query.count, 0), max),
  };
}

/**
 * The time reported as `meta.lastModified`. Polaris ID skips its own update when its change is older than this,
 * so it is reported a minute early: a clock that runs behind ours, or a change in the same minute, still gets
 * through. The cost of being early is one extra PUT.
 */
export const SKEW_MS = 60_000;
const iso = (ms: number): string => new Date(Math.max(ms, 0)).toISOString();

const meta = (type: 'User' | 'Group', id: string, lastModified: number) => ({
  resourceType: type,
  created: iso(lastModified),
  lastModified: iso(lastModified - SKEW_MS),
  location: `/scim/v2/${type}s/${id}`,
});

/** A user as the receiver answers: `userName` is the subject, the only identifier it keeps. */
export const userResource = (u: DirectoryUser) => ({
  schemas: [SCIM_USER_SCHEMA],
  id: u.scim_id,
  externalId: u.subject,
  userName: u.subject,
  active: u.active === 1,
  meta: meta('User', u.scim_id, u.last_modified),
});

export const groupResource = (g: DirectoryGroup) => ({
  schemas: [SCIM_GROUP_SCHEMA],
  id: g.scim_id,
  externalId: g.group_id,
  displayName: g.group_id,
  members: membersOf(g).map((value) => ({ value })),
  meta: meta('Group', g.scim_id, g.last_modified),
});

export const listResponse = (resources: readonly object[], total: number, startIndex: number) => ({
  schemas: [LIST_SCHEMA],
  totalResults: total,
  startIndex: Math.max(startIndex, 1),
  itemsPerPage: resources.length,
  Resources: resources,
});

export function scimJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': SCIM_CONTENT_TYPE, 'cache-control': 'private, no-store' },
  });
}
