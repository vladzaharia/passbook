import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { MODE_HEADER, type Mode } from '../../../shared/contracts/common.ts';
import { createApp } from '../../app.ts';
import { createAuthStores } from '../../stores.ts';
import { resolveSession } from '../auth/sessions.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { grantScanMembership } from '../scan/test-kit.ts';
import { keysetAuthorityOf } from './keysets.ts';
import { tagFixture } from './tags-test-fixtures.ts';

/** Orgs with members at a role, the app, and a caller for /api/v1/nfc. One per test file. */
export async function keysetFixture() {
  const f = await tagFixture();
  const { kit } = f;
  const app = createApp({ stores: (env) => createAuthStores(env, kit.clock), clock: kit.clock });

  async function member(
    orgId: string,
    roles: Parameters<typeof grantScanMembership>[3],
    authTime?: number,
  ) {
    const user = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, orgId, user.id, roles);
    const session = await makeSession(kit.fx, {
      userId: user.id,
      roles: ['user'],
      ...(authTime === undefined ? {} : { authTime }),
    });
    const resolved = await resolveSession(kit.env, kit.clock, session.cookieValue);
    if (!resolved) throw new Error('The member session did not resolve.');
    return {
      user,
      headers: session.headers,
      /** The captured scanning:manage authority, as a route builds it. */
      authority: async (mode: Mode = 'live') =>
        keysetAuthorityOf(
          await tenantAuthorityOf(kit.ctx, { ...resolved, mode }, orgId, 'scanning:manage'),
        ),
    };
  }

  const call = (
    headers: Record<string, string>,
    method: string,
    path: string,
    body?: unknown,
    mode: Mode = 'live',
  ) =>
    app.request(
      `https://wallet.test/api/v1/nfc${path}`,
      {
        method,
        headers: {
          ...headers,
          [MODE_HEADER]: mode,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      kit.env,
    );

  /** An org with an admin (scanning:manage) and a pass operator (scanning:read only). */
  async function org(adminAuthTime?: number) {
    const { org: row } = await f.org();
    return {
      org: row,
      admin: await member(row.id, ['org_admin'], adminAuthTime),
      operator: await member(row.id, ['pass_operator']),
    };
  }

  return { ...f, call, org, member };
}
