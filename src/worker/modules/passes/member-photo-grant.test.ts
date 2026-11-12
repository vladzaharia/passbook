import { beforeAll, describe, expect, it } from 'vitest';
import {
  assertNoLeakedGrants,
  makeOrg,
  makeSession,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import {
  encoded,
  type MemberPhotoFixture,
  setupPhotoTestKit,
} from './member-photo-test-fixtures.ts';

let fx: MemberPhotoFixture;
let kit: MemberPhotoFixture['kit'];

beforeAll(async () => {
  fx = await setupPhotoTestKit();
  kit = fx.kit;
}, 60_000);

async function operator(orgId = kit.org.id) {
  const user = await makeUser(kit.fx);
  const now = kit.clock.now();
  const invitation = kit.fx.ids.id();
  const membershipId = kit.fx.ids.id();
  await run(
    kit.env.DB,
    `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      invitation,
      orgId,
      user.primaryEmail,
      '["pass_operator"]',
      kit.fx.ids.token(),
      now,
      now + 60_000,
      now,
    ],
  );
  await run(
    kit.env.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [membershipId, orgId, user.id, invitation, '["pass_operator"]', now],
  );
  const session = await makeSession(kit.fx, { userId: user.id, roles: ['user'] });
  return { membershipId, headers: { ...session.headers, origin: 'https://wallet.test' } };
}

const row = (id: string) =>
  first<{ version: string; include_in_pass: number }>(
    kit.env.DB,
    'SELECT version, include_in_pass FROM member_photos WHERE pass_id = ?',
    [id],
  );

describe('member photo writes as grants', () => {
  it('uploads, replaces and removes through a session', async () => {
    const actor = await operator();
    const pass = await kit.pass();
    const put = await fx.api(pass.id, 'PUT', { png: encoded, includeInPass: false }, actor.headers);
    expect(put.status).toBe(200);
    const first1 = await row(pass.id);
    expect(first1?.include_in_pass).toBe(0);
    const again = await fx.api(
      pass.id,
      'PUT',
      { png: encoded, includeInPass: true },
      actor.headers,
    );
    expect(again.status).toBe(200);
    const second = await row(pass.id);
    expect(second?.version).not.toBe(first1?.version);
    expect(second?.include_in_pass).toBe(1);
    expect((await fx.api(pass.id, 'DELETE', undefined, actor.headers)).status).toBe(200);
    expect(await row(pass.id)).toBeNull();
    await assertNoLeakedGrants(kit.env.DB);
  });

  it('refuses a revoked membership with 403 and writes nothing', async () => {
    const actor = await operator();
    const pass = await kit.pass();
    await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      actor.membershipId,
    ]);
    const put = await fx.api(pass.id, 'PUT', { png: encoded, includeInPass: false }, actor.headers);
    expect(put.status).toBe(403);
    expect(await row(pass.id)).toBeNull();
  });

  it('refuses a pass of another org', async () => {
    const other = await makeOrg(kit.fx, { name: 'Other tenant' });
    const actor = await operator(other.id);
    const pass = await kit.pass();
    const put = await fx.api(pass.id, 'PUT', { png: encoded, includeInPass: false }, actor.headers);
    expect([403, 404]).toContain(put.status);
    expect(await row(pass.id)).toBeNull();
  });

  it('is not failed by a rename or branding save', async () => {
    const actor = await operator();
    const pass = await kit.pass();
    await run(kit.env.DB, 'UPDATE orgs SET name = ?, branding = ? WHERE id = ?', [
      'Renamed',
      JSON.stringify({ accent: 'red' }),
      kit.org.id,
    ]);
    const put = await fx.api(pass.id, 'PUT', { png: encoded, includeInPass: false }, actor.headers);
    expect(put.status).toBe(200);
    expect(await row(pass.id)).not.toBeNull();
  });
});
