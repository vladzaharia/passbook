import {
  apiKeyDto,
  auditAccountCreated,
  clientDto,
  configVariable,
  groupDto,
  type Layout,
  paginated,
  signupTokenDto,
  type UserFields,
  userDto,
} from './fixtures.ts';

export const CLIENT_ID = 'client-1';
export const KEY_USER = 'key-user';
export const GROUPS = {
  console: { id: 'g-console', name: 'passbook_console' },
  developer: { id: 'g-dev', name: 'passbook_developers' },
  support: { id: 'g-support', name: 'passbook_support' },
  platform_admin: { id: 'g-admins', name: 'passbook_platform_admins' },
  users: { id: 'g-users', name: 'passbook_users' },
} as const;
/** Kept for the DI-1 tests that name the developers group. */
export const DEV_GROUP = GROUPS.developer;
export const SAFE_CONFIG: Record<string, string> = {
  allowUserSignups: 'withToken',
  emailVerification: 'required',
  requireUserEmail: 'true',
  emailsVerified: 'false',
  signupDefaultUserGroupIDs: '[]',
};

export interface Seen {
  method: string;
  path: string;
  key: string;
  redirect: string | undefined;
  body: unknown;
}
interface User extends UserFields {
  groups: string[];
  claims?: { key: string; value: string }[];
}
interface GroupMeta {
  friendly: string;
  createdAt: number;
  claims: { key: string; value: string }[];
  clients: string[];
}
const RESERVED = ['sub', 'email', 'name', 'groups', 'iss', 'aud', 'exp', 'iat'];
interface Token {
  id: string;
  value: string;
  expiresAt: number;
  usageCount: number;
  groups: string[];
}

/** A small stateful Polaris ID for one route layout: the routes the binding uses, answering with the recorded DTO shapes. */
export function fakePocket(layout: Layout, clock: { now: number }) {
  const base = layout === 'admin' ? '/api/admin' : '/api';
  const groups = new Map<string, string>([
    ...Object.values(GROUPS).map((g) => [g.id, g.name] as [string, string]),
    ['g-other', 'staff'],
    ['g-extra', 'other_app'],
  ]);
  const meta = new Map<string, GroupMeta>();
  const metaOf = (id: string): GroupMeta => {
    let m = meta.get(id);
    if (!m) {
      m = { friendly: nameOf(id), createdAt: 0, claims: [], clients: [] };
      meta.set(id, m);
    }
    return m;
  };
  const s = {
    config: { ...SAFE_CONFIG },
    /** Per-group state the fake keeps: display name, claims and allowed clients. */
    meta,
    /** Rewrites what a claim PUT stores (drift). */
    claimsTransform: undefined as
      | ((claims: { key: string; value: string }[]) => { key: string; value: string }[])
      | undefined,
    users: new Map<string, User>(),
    tokens: [] as Token[],
    audit: [] as ReturnType<typeof auditAccountCreated>[],
    keyExpires: '2027-02-20T00:00:00Z',
    /** Renames a group as Polaris ID reports it. */
    groupNames: {} as Record<string, string>,
    client: {
      restricted: true,
      allowed: Object.values(GROUPS)
        .filter((g) => g.id !== 'g-support')
        .map((g) => g.id as string),
    },
    /** Rewrites what the next group PUT stores (drift), or fails a request with a status. */
    putTransform: undefined as ((ids: string[]) => string[]) | undefined,
    putUserTransform: undefined as
      | ((body: Record<string, unknown>) => Record<string, unknown>)
      | undefined,
    tokenGroups: undefined as string[] | undefined,
    failWith: undefined as { match: RegExp; status: number; body?: unknown } | undefined,
    /** Rewrites the user DTO of GET user answers. */
    userDto: undefined as ((dto: Record<string, unknown>) => Record<string, unknown>) | undefined,
    /** Runs at the start of every request, before it is answered (to interleave another call). */
    hook: undefined as ((method: string, path: string) => Promise<void>) | undefined,
    /** A body to answer a request with instead of the fake's own, or undefined. */
    override: undefined as ((method: string, path: string) => unknown) | undefined,
    /** Group ids Polaris ID answers 404 for. */
    missing: new Set<string>(),
    seen: [] as Seen[],
  };
  const json = (body: unknown, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const nameOf = (id: string) => s.groupNames[id] ?? groups.get(id) ?? id;
  const groupList = (ids: string[]) => ids.map((id) => groupDto(id, nameOf(id)));
  const user = (id: string) => {
    const u = s.users.get(id);
    return (
      u && { ...userDto(id, u), userGroups: groupList(u.groups), customClaims: u.claims ?? [] }
    );
  };
  const members = (gid: string) =>
    [...s.users.entries()].filter(([, u]) => u.groups.includes(gid)).map(([id]) => user(id));
  s.users.set(KEY_USER, {
    ...userFields(KEY_USER, { isAdmin: true }),
    groups: [],
  });

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname;
    const full = `${path}${url.search}`;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    s.seen.push({
      method,
      path: full,
      key: new Headers(init?.headers).get('x-api-key') ?? '',
      redirect: init?.redirect,
      body,
    });
    await s.hook?.(method, full);
    const forced = s.override?.(method, full);
    if (forced !== undefined) return json(forced);
    if (s.failWith?.match.test(`${method} ${full}`))
      return json(s.failWith.body ?? { message: 'nope' }, s.failWith.status);

    const group = path.match(new RegExp(`^${base}/user-groups/([^/]+)$`));
    const dto = (gid: string) => {
      const m = metaOf(gid);
      return {
        ...groupDto(gid, nameOf(gid), members(gid)),
        friendlyName: m.friendly,
        customClaims: m.claims,
        allowedOidcClients: m.clients.map((id) => ({ id })),
      };
    };
    if (method === 'GET' && group) {
      const gid = group[1] as string;
      return groups.has(gid) && !s.missing.has(gid)
        ? json(dto(gid))
        : json({ error: 'not found' }, 404);
    }
    if (path === `${base}/user-groups` && method === 'GET') {
      const q = url.searchParams.get('search') ?? '';
      const hits = [...groups.keys()].filter((id) => nameOf(id).includes(q) && !s.missing.has(id));
      return json(
        paginated(
          hits.map((id) => ({
            ...groupDto(id, nameOf(id)),
            createdAt: new Date(metaOf(id).createdAt || clock.now).toISOString(),
          })),
        ),
      );
    }
    if (path === `${base}/user-groups` && method === 'POST') {
      const b = body as { name: string; friendlyName: string };
      if ([...groups.entries()].some(([id, n]) => n === b.name && !s.missing.has(id)))
        return json({ error: 'in use' }, 409);
      const id = `g-new-${groups.size}`;
      groups.set(id, b.name);
      meta.set(id, { friendly: b.friendlyName, createdAt: clock.now, claims: [], clients: [] });
      return json(dto(id), 201);
    }
    if (group && method === 'PUT') {
      const gid = group[1] as string;
      if (!groups.has(gid)) return json({ error: 'not found' }, 404);
      const b = body as { name: string; friendlyName: string };
      groups.set(gid, b.name);
      metaOf(gid).friendly = b.friendlyName;
      return json(dto(gid));
    }
    if (group && method === 'DELETE') {
      groups.delete(group[1] as string);
      return json(null, 204);
    }
    const clients = path.match(new RegExp(`^${base}/user-groups/([^/]+)/allowed-oidc-clients$`));
    if (clients && method === 'PUT') {
      metaOf(clients[1] as string).clients = (body as { oidcClientIds: string[] }).oidcClientIds;
      return json(null, 204);
    }
    const claimPut = path.match(new RegExp(`^${base}/custom-claims/(user|user-group)/([^/]+)$`));
    if (claimPut && method === 'PUT') {
      const list = body as { key: string; value: string }[];
      const keys = list.map((c) => c.key);
      if (new Set(keys).size !== keys.length || keys.some((k) => RESERVED.includes(k)))
        return json({ error: 'invalid claims' }, 400);
      const stored = s.claimsTransform ? s.claimsTransform(list) : list;
      if (claimPut[1] === 'user') {
        const u = s.users.get(claimPut[2] as string);
        if (!u) return json({ error: 'not found' }, 404);
        u.claims = stored;
      } else metaOf(claimPut[2] as string).claims = stored;
      return json(null, 204);
    }
    const configPath =
      layout === 'admin'
        ? '/api/admin/application-configuration'
        : '/api/application-configuration/all';
    if (method === 'GET' && path === configPath)
      return json(Object.entries(s.config).map(([k, v]) => configVariable(k, v)));
    if (method === 'GET' && path === '/api/api-keys')
      return json(paginated([apiKeyDto('k1', s.keyExpires)]));
    if (method === 'GET' && path === `${base}/users/me`) return json(user(KEY_USER));
    const client = path.match(new RegExp(`^${base}/oidc/clients/([^/]+)$`));
    if (method === 'GET' && client)
      return client[1] === CLIENT_ID
        ? json(
            clientDto(
              CLIENT_ID,
              s.client.restricted,
              s.client.allowed.map((id) => ({ id, name: nameOf(id) })),
            ),
          )
        : json({ error: 'not found' }, 404);

    if (method === 'GET' && path === `${base}/users`) {
      const q = (url.searchParams.get('search') ?? '').toLowerCase();
      const page = Number(url.searchParams.get('pagination[page]') ?? '1');
      const hits = [...s.users.entries()]
        .filter(
          ([id, u]) =>
            id !== KEY_USER &&
            (u.email.toLowerCase().includes(q) || u.username.toLowerCase().includes(q)),
        )
        .map(([id]) => user(id) as Record<string, unknown>)
        .map((dto) => (s.userDto ? s.userDto(dto) : dto));
      return json({
        data: hits.slice((page - 1) * 100, page * 100),
        pagination: {
          totalPages: Math.max(1, Math.ceil(hits.length / 100)),
          totalItems: hits.length,
          currentPage: page,
          itemsPerPage: 100,
        },
      });
    }

    if (path === `${base}/signup-tokens` && method === 'POST') {
      const ids = (body as { userGroupIds: string[] }).userGroupIds;
      const n = s.tokens.length + 1;
      const t: Token = {
        id: `tok-id-${n}`,
        value: `SECRETTOKEN${n}abcdef`,
        expiresAt: clock.now + 3_600_000,
        usageCount: 0,
        groups: s.tokenGroups ?? ids,
      };
      s.tokens.push(t);
      return json(tokenDto(t), 201);
    }
    if (path === `${base}/signup-tokens` && method === 'GET')
      return json(paginated(s.tokens.map(tokenDto)));
    const tok = path.match(new RegExp(`^${base}/signup-tokens/([^/]+)$`));
    if (tok && method === 'DELETE') {
      const i = s.tokens.findIndex((t) => t.id === tok[1]);
      if (i < 0) return json({ error: 'not found' }, 404);
      s.tokens.splice(i, 1);
      return json(null, 204);
    }

    const auditPath = layout === 'admin' ? '/api/admin/audit-logs' : '/api/audit-logs/all';
    if (method === 'GET' && path === auditPath) {
      const page = Number(url.searchParams.get('pagination[page]') ?? '1');
      const rows = [...s.audit].reverse();
      return json({
        data: rows.slice((page - 1) * 100, page * 100),
        pagination: {
          totalPages: Math.max(1, Math.ceil(rows.length / 100)),
          totalItems: rows.length,
          currentPage: page,
          itemsPerPage: 100,
        },
      });
    }

    const ug = path.match(new RegExp(`^${base}/users/([^/]+)(/groups|/user-groups)?$`));
    if (ug) {
      const u = s.users.get(ug[1] as string);
      if (!u) return json({ error: 'not found' }, 404);
      if (method === 'GET' && !ug[2]) {
        const dto = user(ug[1] as string) as Record<string, unknown>;
        return json(s.userDto ? s.userDto(dto) : dto);
      }
      if (method === 'GET' && ug[2] === '/groups') return json(groupList(u.groups));
      if (method === 'PUT' && ug[2] === '/user-groups') {
        const ids = (body as { userGroupIds: string[] }).userGroupIds;
        u.groups = s.putTransform ? s.putTransform(ids) : ids;
        return json(user(ug[1] as string));
      }
      if (method === 'PUT' && !ug[2]) {
        // Polaris ID binds one DTO: a missing field fails validation, so a partial echo cannot slip through.
        const fields = Object.keys(userFields('x'));
        const sent = body as Record<string, unknown>;
        if (fields.some((f) => !(f in sent))) return json({ error: 'invalid' }, 400);
        const applied = s.putUserTransform ? s.putUserTransform(sent) : sent;
        Object.assign(u, Object.fromEntries(fields.map((f) => [f, applied[f]])));
        return json(user(ug[1] as string));
      }
    }
    return json({ error: 'unrouted' }, 404);
  };

  const tokenDto = (t: Token) =>
    signupTokenDto(layout, {
      id: t.id,
      token: t.value,
      expiresAt: new Date(t.expiresAt).toISOString(),
      usageCount: t.usageCount,
      groups: t.groups.map((id) => ({ id, name: nameOf(id) })),
    });

  return {
    s,
    fetch,
    /** A group Polaris ID already has, made at `createdAt` (default: now). */
    addGroup(id: string, name: string, friendly = name, createdAt = clock.now) {
      groups.set(id, name);
      meta.set(id, { friendly, createdAt, claims: [], clients: [] });
    },
    addUser(id: string, o: Partial<User> = {}) {
      s.users.set(id, { ...userFields(id), groups: ['g-other'], ...o });
    },
    /** Polaris ID's signup: consumes the token, creates the account with the token's groups, writes the audit row. */
    signUp(tokenId: string, userId: string, at = clock.now) {
      const t = s.tokens.find((x) => x.id === tokenId);
      if (!t) throw new Error('no such token');
      t.usageCount += 1;
      s.users.set(userId, { ...userFields(userId), groups: [...t.groups] });
      s.audit.push(
        auditAccountCreated(layout, {
          id: `a${s.audit.length + 1}`,
          userId,
          createdAt: new Date(at).toISOString(),
          token: { id: t.id, value: t.value },
        }),
      );
    },
    writes: () => s.seen.filter((x) => x.method !== 'GET'),
  };
}
export type FakePocket = ReturnType<typeof fakePocket>;

function userFields(id: string, o: Partial<UserFields> = {}): UserFields {
  const { id: _id, customClaims: _c, userGroups: _g, ldapId: _l, ...fields } = userDto(id, o);
  return fields;
}
