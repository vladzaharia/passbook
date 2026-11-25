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

const invitation = (
  id: string,
  orgId: string,
  roles = '["org_admin"]',
  email = 'x@example.com',
) => [
  ['id', 'org_id', 'email', 'roles', 'token_hash', 'created_at', 'expires_at', 'accepted_at'],
  [id, orgId, email, roles, `${id}-hash`, 1, 1, 1],
];

describe('platform.org.personal', () => {
  it('writes the org, its entitlements, an accepted invitation and the membership for the principal', async () => {
    const { g, user, orgId } = await personalGrant('personal-ok', ['admin', 'user']);
    const slug = `personal-${orgId.slice(0, 8)}`;
    g.insertSelect('orgs', ORG_COLUMNS, [orgId, slug, 'Ada', 1, 1, user.id]);
    g.insertSelect('org_entitlements', ['org_id', 'preset', 'updated_at'], [orgId, 'legacy', 1]);
    const [cols, vals] = invitation('inv-ok', orgId, '["org_admin"]', user.primaryEmail);
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

  it('refuses children of an org this grant did not insert, an open invitation and a plan other than Unlimited', async () => {
    const { g, user, orgId } = await personalGrant('personal-children', ['admin', 'user']);
    const [cols, vals] = invitation('inv-c', orgId);
    expect(() => g.insertSelect('org_invitations', cols as string[], vals as never)).toThrow(
      /follows the orgs row/,
    );
    expect(() =>
      g.insertSelect(
        'org_memberships',
        ['id', 'org_id', 'user_id', 'invitation_id', 'roles', 'created_at'],
        ['m', orgId, user.id, 'inv-c', '["org_admin"]', 1],
      ),
    ).toThrow(/follows the orgs row/);
    g.insertSelect('orgs', ORG_COLUMNS, [orgId, 'personal-c', 'C', 1, 1, user.id]);
    expect(() =>
      g.insertSelect('org_entitlements', ['org_id', 'preset', 'updated_at'], [orgId, 'trial', 1]),
    ).toThrow(/unlimited preset/);
    const open = [...(vals as unknown[])];
    open[7] = null;
    expect(() => g.insertSelect('org_invitations', cols as string[], open as never)).toThrow(
      /already accepted/,
    );
    expect(() =>
      g.insertSelect(
        'org_memberships',
        ['id', 'org_id', 'user_id', 'invitation_id', 'roles', 'created_at'],
        ['m', orgId, user.id, 'unknown-invitation', '["org_admin"]', 1],
      ),
    ).toThrow(/same grant/);
  });

  it('refuses a non-standard org kind or status', async () => {
    const { g, user, orgId } = await personalGrant('personal-kind', ['admin', 'user']);
    expect(() =>
      g.insertSelect(
        'orgs',
        [...ORG_COLUMNS, 'kind'],
        [orgId, 'personal-k', 'K', 1, 1, user.id, 'developer'],
      ),
    ).toThrow(/standard org/);
    expect(() =>
      g.insertSelect(
        'orgs',
        [...ORG_COLUMNS, 'status'],
        [orgId, 'personal-k', 'K', 1, 1, user.id, 'suspended'],
      ),
    ).toThrow(/standard org/);
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
    g.insertSelect('orgs', ORG_COLUMNS, [orgId, 'personal-m', 'M', 1, 1, user.id]);
    g.insertSelect('org_invitations', ...(invitation('i', orgId) as [string[], never]));
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

  it('records nothing from a refused row', async () => {
    const { g, user, orgId } = await personalGrant('personal-refused', ['admin', 'user']);
    g.insertSelect('orgs', ORG_COLUMNS, [orgId, 'personal-r', 'R', 1, 1, user.id]);
    const [cols, vals] = invitation('inv-r', orgId, '["read_only"]', user.primaryEmail);
    expect(() => g.insertSelect('org_invitations', cols as string[], vals as never)).toThrow(
      /org_admin only/,
    );
    expect(() =>
      g.insertSelect(
        'org_memberships',
        ['id', 'org_id', 'user_id', 'invitation_id', 'roles', 'created_at'],
        ['m-r', orgId, user.id, 'inv-r', '["org_admin"]', 1],
      ),
    ).toThrow(/same grant/);
    const refusedOrg = await personalGrant('personal-refused-org', ['admin', 'user']);
    expect(() =>
      refusedOrg.g.insertSelect('orgs', ORG_COLUMNS, [
        refusedOrg.orgId,
        'personal-x',
        'X',
        1,
        1,
        'someone-else',
      ]),
    ).toThrow(/grant principal/);
    expect(() =>
      refusedOrg.g.insertSelect(
        'org_entitlements',
        ['org_id', 'preset', 'updated_at'],
        [refusedOrg.orgId, 'standard', 1],
      ),
    ).toThrow(/follows the orgs row/);
  });

  it('shares no state between grants built from one input object', async () => {
    const { s, route } = await setupGrant('personal-shared-input');
    const user = await makeUser(s.f);
    const session = await makeSession(s.f, { userId: user.id, roles: ['admin', 'user'] });
    const orgId = s.f.ids.id();
    const input = {
      purpose: PERSONAL_ORG_PURPOSE,
      principal: {
        kind: 'platform' as const,
        userId: user.id,
        sessionIdHash: await sha256Hex(session.cookieValue),
      },
      target: orgId,
      tables: PERSONAL_ORG_TABLES,
    };
    const first = grant(route, input);
    const second = grant(route, input);
    first.insertSelect('orgs', ORG_COLUMNS, [orgId, 'personal-s', 'S', 1, 1, user.id]);
    expect(() =>
      second.insertSelect(
        'org_entitlements',
        ['org_id', 'preset', 'updated_at'],
        [orgId, 'standard', 1],
      ),
    ).toThrow(/follows the orgs row/);
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
