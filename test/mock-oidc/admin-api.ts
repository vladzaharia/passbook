import { fakePocket } from '../polaris-binding/fake-pocket.ts';
import type { MockOidc } from './index.ts';
import { scimPush } from './scim-push.ts';
import { signUp } from './signup.ts';

const ROLE_GROUPS = [
  'passbook_console',
  'passbook_developers',
  'passbook_support',
  'passbook_platform_admins',
];

export interface MockPolarisOptions {
  oidc: MockOidc;
  /** The key the binding sends in `X-API-KEY`; any other is answered 401, as Polaris ID does. */
  apiKey: string;
  /** The main Worker, for SCIM pushes. */
  appOrigin: string;
  /** The bearer the main Worker's SCIM receiver expects. */
  scimToken: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * Polaris ID for the e2e stack: the admin API the binding calls (the same stateful fake the binding's own tests use,
 * test/polaris-binding/fake-pocket.ts), plus `/__polaris/*` controls a spec uses to play the owner and the person
 * signing up. Accounts made here can sign in through the mock OIDC provider, with the groups Polaris ID says they hold.
 */
export function createMockPolaris(options: MockPolarisOptions) {
  const clock = {
    get now() {
      return Date.now();
    },
  } as { now: number };
  const pocket = fakePocket('v2', clock);
  const groupNames = (ids: string[]): string[] => ids.map((id) => pocket.nameOf(id));

  /** A person who can sign in: the account's live groups are the token's `groups`, read at sign-in. */
  const register = (sub: string) =>
    options.oidc.addUser({
      sub,
      get email() {
        return pocket.s.users.get(sub)?.email ?? '';
      },
      get name() {
        return pocket.s.users.get(sub)?.displayName ?? sub;
      },
      get emailVerified() {
        return pocket.s.users.get(sub)?.emailVerified ?? false;
      },
      get groups() {
        const u = pocket.s.users.get(sub);
        return u && !u.disabled ? ['wallet_users', ...groupNames(u.groups)] : [];
      },
      // The PassBook client lets in only accounts in a PassBook role group, as Polaris ID is set up.
      requiresGroups: ROLE_GROUPS,
    });

  async function control(path: string, body: Record<string, unknown>): Promise<Response> {
    switch (path) {
      case 'signup':
        return json(signUp(pocket, register, body as never));
      case 'account': {
        // An account Polaris ID already had: the "I have a Polaris ID" paths.
        const sub = String(body.sub);
        pocket.addUser(sub, {
          email: String(body.email),
          displayName: String(body.name ?? sub),
          emailVerified: body.verified !== false,
          groups: [],
        });
        register(sub);
        return json({ sub });
      }
      case 'owner-remove': {
        // The owner takes a person out of a group in Polaris ID itself.
        const u = pocket.s.users.get(String(body.sub));
        if (!u) return json({ error: 'no such account' }, 404);
        const gid = pocket.idOfName(String(body.group));
        u.groups = u.groups.filter((g) => g !== gid);
        return json({ groups: groupNames(u.groups) });
      }
      case 'disable': {
        const u = pocket.s.users.get(String(body.sub));
        if (!u) return json({ error: 'no such account' }, 404);
        u.disabled = body.disabled !== false;
        return json({ ok: true });
      }
      case 'fail': {
        // The next requests matching `match` (a regexp over "METHOD /path") answer `status`; no body clears it.
        pocket.s.failWith =
          typeof body.match === 'string'
            ? { match: new RegExp(body.match), status: Number(body.status ?? 500) }
            : undefined;
        return json({ ok: true });
      }
      case 'scim':
        return json(await scimPush(options, body as never));
      case 'state': {
        const sub = typeof body.sub === 'string' ? body.sub : null;
        const u = sub ? pocket.s.users.get(sub) : undefined;
        return json({
          user: u ? { ...u, groups: groupNames(u.groups) } : null,
          groups: pocket.roster(),
          tokens: pocket.s.tokens.length,
          writes: pocket.writes().map((w) => `${w.method} ${w.path}`),
        });
      }
      default:
        return json({ error: 'unknown control' }, 404);
    }
  }

  /** Answers `/api/*` (the admin API) and `/__polaris/*`; null for everything else. */
  async function handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/__polaris/'))
      return control(
        url.pathname.slice('/__polaris/'.length),
        request.method === 'POST' ? ((await request.json().catch(() => ({}))) as never) : {},
      );
    if (!url.pathname.startsWith('/api/') || /^\/api\/oidc\/(token|end-session)/.test(url.pathname))
      return null;
    if (request.headers.get('x-api-key') !== options.apiKey)
      return json({ error: 'Invalid API key' }, 401);
    const body = request.body ? await request.text() : undefined;
    return pocket.fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(body ? { body } : {}),
    });
  }

  return { handle, pocket };
}
