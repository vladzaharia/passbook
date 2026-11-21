import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { makeSession, makeUser } from '../../../test/helpers/index.ts';
import { grant } from './authority.ts';
import { CREATOR_ORG_PURPOSE, PERSONAL_ORG_TABLES } from './authority-personal.ts';
import { setupGrant } from './authority-test-fixtures.ts';
import { first } from './db.ts';
import { sha256Hex } from './ids.ts';

const ORG_COLUMNS = ['id', 'slug', 'name', 'created_at', 'updated_at'];
const INVITATION = [
  'id',
  'org_id',
  'email',
  'roles',
  'token_hash',
  'created_at',
  'expires_at',
  'accepted_at',
];
const MEMBERSHIP = ['id', 'org_id', 'user_id', 'invitation_id', 'roles', 'created_at'];

async function creatorGrant(label: string) {
  const { s, route } = await setupGrant(label);
  const user = await makeUser(s.f);
  const other = await makeUser(s.f);
  const session = await makeSession(s.f, { userId: user.id, roles: ['admin', 'user'] });
  const orgId = s.f.ids.id();
  const g = grant(route, {
    purpose: CREATOR_ORG_PURPOSE,
    principal: {
      kind: 'platform',
      userId: user.id,
      sessionIdHash: await sha256Hex(session.cookieValue),
    },
    target: orgId,
    tables: PERSONAL_ORG_TABLES,
  });
  return { g, user, other, orgId };
}

describe('platform.org.create_admin', () => {
  it('writes the org, its entitlements, the accepted invitation and the principal as org_admin', async () => {
    const { g, user, orgId } = await creatorGrant('creator-ok');
    g.insertSelect('orgs', ORG_COLUMNS, [orgId, `c-${orgId.slice(0, 8)}`, 'Acme', 1, 1]);
    g.insertSelect('org_entitlements', ['org_id', 'preset', 'updated_at'], [orgId, 'trial', 1]);
    g.insertSelect('org_invitations', INVITATION, [
      'inv',
      orgId,
      user.primaryEmail,
      '["org_admin"]',
      'h',
      1,
      1,
      1,
    ]);
    g.insertSelect('org_memberships', MEMBERSHIP, [
      'mem',
      orgId,
      user.id,
      'inv',
      '["org_admin"]',
      1,
    ]);
    await g.commit();
    expect(
      await first(env.DB, 'SELECT user_id FROM org_memberships WHERE org_id = ?', [orgId]),
    ).toMatchObject({ user_id: user.id });
    expect(
      await first(env.DB, 'SELECT personal_user_id FROM orgs WHERE id = ?', [orgId]),
    ).toMatchObject({ personal_user_id: null });
  });

  it('refuses another user, a wider role, a personal marker, a sandbox and an open invitation', async () => {
    const { g, user, other, orgId } = await creatorGrant('creator-refused');
    expect(() =>
      g.insertSelect(
        'orgs',
        [...ORG_COLUMNS, 'personal_user_id'],
        [orgId, 'c-p', 'P', 1, 1, user.id],
      ),
    ).toThrow(/not personal/);
    g.insertSelect('orgs', ORG_COLUMNS, [orgId, 'c-r', 'R', 1, 1]);
    expect(() =>
      g.insertSelect(
        'org_entitlements',
        ['org_id', 'preset', 'updated_at'],
        [orgId, 'developer', 1],
      ),
    ).toThrow(/sandbox/);
    expect(() =>
      g.insertSelect('org_invitations', INVITATION, [
        'inv',
        orgId,
        'x@example.com',
        '["org_admin"]',
        'h',
        1,
        1,
        null,
      ]),
    ).toThrow(/already accepted/);
    g.insertSelect('org_invitations', INVITATION, [
      'inv',
      orgId,
      'x@example.com',
      '["org_admin"]',
      'h',
      1,
      1,
      1,
    ]);
    expect(() =>
      g.insertSelect('org_memberships', MEMBERSHIP, [
        'm',
        orgId,
        other.id,
        'inv',
        '["org_admin"]',
        1,
      ]),
    ).toThrow(/principal only/);
    expect(() =>
      g.insertSelect('org_memberships', MEMBERSHIP, [
        'm',
        orgId,
        user.id,
        'inv',
        '["org_owner"]',
        1,
      ]),
    ).toThrow(/org_admin only/);
  });
});
