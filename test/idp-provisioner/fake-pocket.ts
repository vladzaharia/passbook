import {
  apiKeyDto,
  auditAccountCreated,
  configVariable,
  groupDto,
  type Layout,
  paginated,
  signupTokenDto,
  userDto,
} from './fixtures.ts';

export const DEV_GROUP = { id: 'g-dev', name: 'passbook_developers' };
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
interface User {
  isAdmin: boolean;
  disabled: boolean;
  groups: string[];
}
interface Token {
  id: string;
  value: string;
  expiresAt: number;
  usageCount: number;
  groups: string[];
}

/** A small stateful Pocket ID for one route layout: the routes the provisioner uses, answering with the recorded DTO shapes. */
export function fakePocket(layout: Layout, clock: { now: number }) {
  const base = layout === 'admin' ? '/api/admin' : '/api';
  const groups = new Map<string, string>([
    [DEV_GROUP.id, DEV_GROUP.name],
    ['g-other', 'staff'],
    ['g-admins', 'wallet_admins'],
  ]);
  const s = {
    config: { ...SAFE_CONFIG },
    users: new Map<string, User>(),
    tokens: [] as Token[],
    audit: [] as ReturnType<typeof auditAccountCreated>[],
    keyExpires: '2027-02-20T00:00:00Z',
    groupName: DEV_GROUP.name,
    /** Rewrites what the next PUT stores (drift), or fails a request with a status. */
    putTransform: undefined as ((ids: string[]) => string[]) | undefined,
    tokenGroups: undefined as string[] | undefined,
    failWith: undefined as { match: RegExp; status: number; body?: unknown } | undefined,
    /** Rewrites the user DTO of GET user answers. */
    userDto: undefined as ((dto: Record<string, unknown>) => Record<string, unknown>) | undefined,
    seen: [] as Seen[],
  };
  const json = (body: unknown, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const groupList = (ids: string[]) => ids.map((id) => groupDto(id, groups.get(id) ?? id));
  const user = (id: string) => {
    const u = s.users.get(id);
    return u && { ...userDto(id, u), userGroups: groupList(u.groups) };
  };

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
    if (s.failWith?.match.test(`${method} ${full}`))
      return json(s.failWith.body ?? { message: 'nope' }, s.failWith.status);

    const group = path.match(new RegExp(`^${base}/user-groups/([^/]+)$`));
    if (method === 'GET' && group)
      return group[1] === DEV_GROUP.id
        ? json(groupDto(DEV_GROUP.id, s.groupName))
        : json({ error: 'not found' }, 404);
    const configPath =
      layout === 'admin'
        ? '/api/admin/application-configuration'
        : '/api/application-configuration/all';
    if (method === 'GET' && path === configPath)
      return json(Object.entries(s.config).map(([k, v]) => configVariable(k, v)));
    if (method === 'GET' && path === '/api/api-keys')
      return json(paginated([apiKeyDto('k1', s.keyExpires)]));

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
    }
    return json({ error: 'unrouted' }, 404);
  };

  const tokenDto = (t: Token) =>
    signupTokenDto(layout, {
      id: t.id,
      token: t.value,
      expiresAt: new Date(t.expiresAt).toISOString(),
      usageCount: t.usageCount,
      groups: t.groups.map((id) => ({ id, name: groups.get(id) ?? id })),
    });

  return {
    s,
    fetch,
    addUser(id: string, o: Partial<User> = {}) {
      s.users.set(id, { isAdmin: false, disabled: false, groups: ['g-other'], ...o });
    },
    /** Pocket ID's signup: consumes the token, creates the account with the token's groups, writes the audit row. */
    signUp(tokenId: string, userId: string, at = clock.now) {
      const t = s.tokens.find((x) => x.id === tokenId);
      if (!t) throw new Error('no such token');
      t.usageCount += 1;
      s.users.set(userId, { isAdmin: false, disabled: false, groups: [...t.groups] });
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
