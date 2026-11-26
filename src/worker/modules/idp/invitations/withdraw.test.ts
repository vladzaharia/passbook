import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeFakeIdp } from '../../../../../test/helpers/fake-idp.ts';
import { member } from '../../api-keys/test-kit.ts';
import {
  challenge,
  developerInvite,
  memberInvite,
  post,
  type Rig,
  rig,
  rowsOf,
  teardown,
} from './invitations-test-fixtures.ts';

let r: Rig;
beforeEach(async () => {
  r = await rig();
});
afterEach(teardown);

const revokeMember = (headers: Record<string, string>, id: string) =>
  r.h.call(`/api/v1/orgs/${r.orgId}/invitations/${id}`, { method: 'DELETE', headers });
const revokeDeveloper = (headers: Record<string, string>, id: string) =>
  r.h.call(`/api/v1/orgs/${r.orgId}/developer-invitations/${id}`, { method: 'DELETE', headers });
const tokens = () => [...r.idp.signups.keys()];

describe('revoking an invitation withdraws its unused signup tokens', () => {
  it('a member invitation: the token is gone from Polaris ID at once, its id stays on record', async () => {
    const { session } = await member('org_admin');
    const invite = await memberInvite(r, 'agent@agency.test');
    await post(r, '/setup', challenge(invite.secret));
    expect(tokens()).toHaveLength(1);
    expect((await revokeMember(session.headers, invite.id)).status).toBe(200);
    expect(tokens()).toEqual([]);
    expect(
      await rowsOf(r, 'SELECT 1 FROM org_invitation_setups WHERE invitation_id = ?', [invite.id]),
    ).toHaveLength(1);
  });

  it('a developer invitation, and the paired member invitation revoked on its own', async () => {
    const { session } = await member('org_admin');
    const alone = await developerInvite(r, 'dev@agency.test', { roles: ['read_only'] });
    await post(r, '/setup', challenge(alone.secret));
    expect(tokens()).toHaveLength(1);
    expect((await revokeDeveloper(session.headers, alone.id)).status).toBe(200);
    expect(tokens()).toEqual([]);

    const paired = await developerInvite(r, 'dev2@agency.test', { roles: ['read_only'] });
    await post(r, '/setup', challenge(paired.secret));
    expect(tokens()).toHaveLength(1);
    expect((await revokeMember(session.headers, paired.memberId as string)).status).toBe(200);
    expect(tokens()).toEqual([]);
  });

  it('keeps a token someone already used, and tokens that already expired are left alone', async () => {
    const { session } = await member('org_admin');
    const invite = await memberInvite(r, 'agent@agency.test');
    await post(r, '/setup', challenge(invite.secret));
    const [used] = tokens();
    r.idp.completeSignup(used as string, 'sub-made');
    r.idp.log.length = 0;
    expect((await revokeMember(session.headers, invite.id)).status).toBe(200);
    expect(tokens()).toEqual([used]);

    const old = await memberInvite(r, 'old@agency.test');
    await post(r, '/setup', challenge(old.secret));
    r.h.clock.advance(2 * 3_600_000);
    r.idp.log.length = 0;
    const fresh = await member('org_admin');
    expect((await revokeMember(fresh.session.headers, old.id)).status).toBe(200);
    expect(r.idp.log).not.toContain('deleteSignup');
  });

  it('never fails the revoke: Polaris ID down leaves the token to the sweep, no binding is no call', async () => {
    const { session } = await member('org_admin');
    const invite = await memberInvite(r, 'agent@agency.test');
    await post(r, '/setup', challenge(invite.secret));
    r.idp.failNext('IDP_UPSTREAM', 'deleteSignup');
    expect((await revokeMember(session.headers, invite.id)).status).toBe(200);
    expect(tokens()).toHaveLength(1);
    expect(
      await rowsOf(
        r,
        'SELECT revoked_at FROM org_invitations WHERE id = ? AND revoked_at IS NOT NULL',
        [invite.id],
      ),
    ).toHaveLength(1);

    const other = await memberInvite(r, 'other@agency.test');
    removeFakeIdp(r.h.env);
    expect((await revokeMember(session.headers, other.id)).status).toBe(200);
  });
});
