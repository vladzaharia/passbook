import { describe, expect, it } from 'vitest';
import {
  fixtures,
  limitSuite,
  makeEnv,
  makeOrg,
  makeSession,
  makeUser,
  refusedWhen,
  setLimit,
} from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { inviteOrgMember, revokeOrgInvitation } from './membership-service.ts';

async function setup() {
  const f = fixtures(await makeEnv());
  const ctx = createServiceContext(f.env, { clock: f.clock });
  const org = await makeOrg(f);
  const user = await makeUser(f);
  const now = f.clock.now();
  const invitation = f.ids.id();
  const roles = JSON.stringify(['org_admin']);
  await run(
    f.env.DB,
    `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [invitation, org.id, user.primaryEmail, roles, f.ids.token(), now, now + 1e6, now],
  );
  await run(
    f.env.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [f.ids.id(), org.id, user.id, invitation, roles, now],
  );
  const session = await makeSession(f, { userId: user.id, roles: ['user'] });
  const auth = await createSessionStore(f.env, f.clock).resolve(session.cookieValue);
  if (!auth) throw new Error('session fixture missing');
  /** Active members and unexpired pending invitations: what the limit counts. */
  const count = async () =>
    (
      await first<{ n: number }>(
        f.env.DB,
        `SELECT (SELECT COUNT(*) FROM org_memberships WHERE org_id = ? AND revoked_at IS NULL)
          + (SELECT COUNT(*) FROM org_invitations WHERE org_id = ? AND revoked_at IS NULL
              AND accepted_at IS NULL AND expires_at > ?) AS n`,
        [org.id, org.id, f.clock.now()],
      )
    )?.n ?? 0;
  const invite = () =>
    inviteOrgMember(ctx, auth, org.id, {
      email: `new-${f.ids.token(8).toLowerCase()}@example.com`,
      roles: ['read_only'],
    });
  return { f, ctx, org, auth, count, invite };
}

limitSuite('members (pending invitations count)', async () => {
  const t = await setup();
  return {
    db: t.f.env.DB,
    orgId: t.org.id,
    key: 'members',
    create: () => refusedWhen(t.invite),
    count: t.count,
  };
});

describe('member limits', () => {
  it('a revoked invitation frees its slot', async () => {
    const t = await setup();
    await setLimit(t.f.env.DB, t.org.id, 'members', 2);
    const invitation = await t.invite();
    expect(await refusedWhen(t.invite)).toMatchObject({ code: 'FEATURE_LIMIT_REACHED', used: 2 });
    await revokeOrgInvitation(t.ctx, t.auth, t.org.id, invitation.id);
    expect(await refusedWhen(t.invite)).toBeNull();
  });
});
