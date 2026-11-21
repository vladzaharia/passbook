import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { makeSession, makeUser } from '../../../test/helpers/index.ts';
import { grant } from './authority.ts';
import { PERSONAL_ORG_PURPOSE, PERSONAL_ORG_TABLES } from './authority-personal.ts';
import { setupGrant } from './authority-test-fixtures.ts';
import { first } from './db.ts';
import { AppError } from './errors.ts';
import { sha256Hex } from './ids.ts';

const ORG_COLUMNS = ['id', 'slug', 'name', 'created_at', 'updated_at', 'personal_user_id'];

/** A grant for `userId`'s admin or plain session, naming a new org. */
async function personalGrant(label: string, roles: ('admin' | 'user')[]) {
  const { s, route } = await setupGrant(label);
  const user = await makeUser(s.f);
  const other = await makeUser(s.f);
  const session = await makeSession(s.f, { userId: user.id, roles });
  const orgId = s.f.ids.id();
  const g = grant(route, {
    purpose: PERSONAL_ORG_PURPOSE,
    principal: {
      kind: 'platform',
      userId: user.id,
      sessionIdHash: await sha256Hex(session.cookieValue),
    },
    target: orgId,
    tables: PERSONAL_ORG_TABLES,
  });
  return { g, user, other, orgId, s };
}

const invitation = (id: string, orgId: string, roles = '["org_admin"]') => [
  ['id', 'org_id', 'email', 'roles', 'token_hash', 'created_at', 'expires_at', 'accepted_at'],
  [id, orgId, 'x@example.com', roles, `${id}-hash`, 1, 1, 1],
];

describe('platform.org.personal', () => {
  it('writes the org, its entitlements, an accepted invitation and the membership for the principal', async () => {
    const { g, user, orgId } = await personalGrant('personal-ok', ['admin', 'user']);
    const slug = `personal-${orgId.slice(0, 8)}`;
    g.insertSelect('orgs', ORG_COLUMNS, [orgId, slug, 'Ada', 1, 1, user.id]);
    g.insertSelect('org_entitlements', ['org_id', 'preset', 'updated_at'], [orgId, 'standard', 1]);
    const [cols, vals] = invitation('inv-ok', orgId);
    g.insertSelect('org_invitations', cols as string[], vals as never);
    g.insertSelect(
      'org_memberships',
      ['id', 'org_id', 'user_id', 'invitation_id', 'roles', 'created_at'],
      ['mem-ok', orgId, user.id, 'inv-ok', '["org_admin"]', 1],
    );
    await g.commit();
    expect(
      await first(env.DB, 'SELECT id FROM orgs WHERE personal_user_id = ?', [user.id]),
    ).toMatchObject({ id: orgId });
  });

  it('cannot create a personal org for a different user', async () => {
    const { g, other, orgId } = await personalGrant('personal-other-org', ['admin', 'user']);
    expect(() =>
      g.insertSelect('orgs', ORG_COLUMNS, [orgId, 'personal-x', 'X', 1, 1, other.id]),
    ).toThrow(/grant principal/);
    expect(() =>
      g.insertSelect(
        'orgs',
        ['id', 'slug', 'name', 'created_at', 'updated_at'],
        [orgId, 'personal-y', 'Y', 1, 1],
      ),
    ).toThrow(/grant principal/);
  });

  it('cannot grant membership to a different user, another role or another org', async () => {
    const { g, user, other, orgId } = await personalGrant('personal-other-member', [
      'admin',
      'user',
    ]);
    const cols = ['id', 'org_id', 'user_id', 'invitation_id', 'roles', 'created_at'];
    expect(() =>
      g.insertSelect('org_memberships', cols, ['m', orgId, other.id, 'i', '["org_admin"]', 1]),
    ).toThrow(/principal only/);
    expect(() =>
      g.insertSelect('org_memberships', cols, ['m', orgId, user.id, 'i', '["read_only"]', 1]),
    ).toThrow(/org_admin only/);
    expect(() =>
      g.insertSelect('org_memberships', cols, [
        'm',
        'another-org',
        user.id,
        'i',
        '["org_admin"]',
        1,
      ]),
    ).toThrow(/grant's org/);
    const [icols, ivals] = invitation('i2', orgId, '["pass_operator"]');
    expect(() => g.insertSelect('org_invitations', icols as string[], ivals as never)).toThrow(
      /org_admin only/,
    );
  });

  it('only inserts, and only into its four tables', async () => {
    const { g, orgId } = await personalGrant('personal-bounds', ['admin', 'user']);
    expect(() => g.update('orgs', { set: { name: 'z' }, where: { id: orgId } })).toThrow(
      /only inserts/,
    );
    expect(() => g.delete('org_memberships', { where: { id: 'm' } })).toThrow(/only inserts/);
    expect(() => g.insertSelect('settings', ['key', 'value', 'updated_at'], ['k', 'v', 1])).toThrow(
      /does not write/,
    );
    expect(() => g.insertSelect('users', ['id'], ['u'])).toThrow();
  });

  it('is refused for a session without the admin role', async () => {
    const { g, user, orgId } = await personalGrant('personal-non-admin', ['user']);
    g.insertSelect('orgs', ORG_COLUMNS, [orgId, 'personal-na', 'NA', 1, 1, user.id]);
    const error = await g.commit().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AppError);
    expect(
      await first(env.DB, 'SELECT id FROM orgs WHERE personal_user_id = ?', [user.id]),
    ).toBeNull();
  });

  it('is held by a platform principal only', async () => {
    const { s, route } = await setupGrant('personal-principal');
    expect(() =>
      grant(route, {
        purpose: PERSONAL_ORG_PURPOSE,
        principal: { kind: 'membership', membershipId: s.membershipId, via: 'deferred' } as never,
      }),
    ).toThrow();
  });
});
