import { expect } from 'vitest';
import { makeOrg, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { WorkbenchTokenSchema } from '../../../shared/contracts/workbench.ts';
import { run } from '../../platform/db.ts';
import { BROWSER, bearer, ORIGIN, tryKit } from '../developer/try-token-test-fixtures.ts';

export { BROWSER, bearer, ORIGIN };

/** The try kit (production stores, Workbench store included) with regular-org members and the Workbench mint. */
export async function workbenchKit() {
  const t = await tryKit();
  const { kit, app } = t;

  /** Any method and JSON body; the response of the app. */
  const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
    app.request(
      `${ORIGIN}/api/v1${path}`,
      {
        method,
        headers: {
          ...headers,
          'content-type': 'application/json',
          'idempotency-key': kit.f.ids.token(),
        },
        ...(body === undefined || method === 'GET' ? {} : { body: JSON.stringify(body) }),
      },
      kit.env,
    );

  /** Makes `userId` a member of `orgId` with `roles`; the membership id. */
  async function join(userId: string, orgId: string, roles: string[]) {
    const now = kit.clock.now();
    const invitationId = kit.f.ids.id();
    await run(
      kit.env.DB,
      `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
       SELECT ?, ?, primary_email, ?, ?, ?, ?, ? FROM users WHERE id = ?`,
      [
        invitationId,
        orgId,
        JSON.stringify(roles),
        kit.f.ids.token(),
        now,
        now + 3600_000,
        now,
        userId,
      ],
    );
    const membershipId = kit.f.ids.id();
    await run(
      kit.env.DB,
      `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [membershipId, orgId, userId, invitationId, JSON.stringify(roles), now],
    );
    return membershipId;
  }

  /** A person in a fresh regular org with `roles`, signed in with Polaris ID. */
  async function member(
    roles: string[] = ['org_admin'],
    sessionRoles: ('admin' | 'user' | 'developer' | 'console')[] = ['user', 'console'],
  ) {
    const org = await makeOrg(kit.f);
    const user = await makeUser(kit.f);
    const membershipId = await join(user.id, org.id, roles);
    const session = await makeSession(kit.f, { userId: user.id, roles: sessionRoles });
    return {
      orgId: org.id,
      user,
      membershipId,
      session,
      browser: { ...session.headers, ...BROWSER },
    };
  }

  /** The session cookie each minted token was made beside. */
  const cookieOf = new Map<string, string>();

  /** `POST /workbench/token` from the signed-in browser. */
  async function wbMint(browser: Record<string, string>, orgId: string) {
    const res = await call('POST', '/workbench/token', browser, { orgId });
    expect(res.status, await res.clone().text()).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const minted = WorkbenchTokenSchema.parse(await res.json());
    if (browser.cookie) cookieOf.set(minted.token, browser.cookie);
    return minted;
  }

  /** The token copied off the page: the bearer alone, no cookie. */
  const bare = (token: string) => ({
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    origin: ORIGIN,
    ...bearer(token),
  });

  /** How the Workbench client calls: the bearer beside its session cookie (same-origin), no mode header. */
  const asClient = (token: string) => ({ ...bare(token), cookie: cookieOf.get(token) ?? '' });

  return { ...t, call, join, member, wbMint, asClient, bare };
}
