import { describe, expect, it, vi } from 'vitest';
import { rolesFromGroups } from './service.ts';

const env = {
  OIDC_PLATFORM_ADMIN_GROUP: 'wallet_admins',
  OIDC_ADMIN_GROUP: 'wallet_org_admins',
  OIDC_DEVELOPER_GROUP: 'passbook_developers',
  OIDC_USER_GROUP: 'wallet_users',
};

describe('rolesFromGroups', () => {
  it('maps each configured group to its roles', () => {
    expect(rolesFromGroups(env, ['wallet_admins'])).toEqual([
      'admin',
      'user',
      'developer',
      'console',
    ]);
    expect(rolesFromGroups(env, ['wallet_org_admins'])).toEqual(['user', 'console']);
    expect(rolesFromGroups(env, ['passbook_developers'])).toEqual(['user', 'developer']);
    expect(rolesFromGroups(env, ['wallet_users'])).toEqual(['user']);
  });

  it('combines groups, platform admin implying developer and console', () => {
    expect(rolesFromGroups(env, ['wallet_users', 'passbook_developers'])).toEqual([
      'user',
      'developer',
    ]);
    expect(rolesFromGroups(env, ['passbook_developers', 'wallet_org_admins'])).toEqual([
      'user',
      'developer',
      'console',
    ]);
  });

  it('matches names exactly: no case folding, no hyphen form, no trimming', () => {
    expect(rolesFromGroups(env, ['passbook-developers', 'wallet-admins', 'wallet-users'])).toEqual(
      [],
    );
    expect(rolesFromGroups(env, ['Wallet_Admins', 'PASSBOOK_DEVELOPERS', 'Wallet Admins'])).toEqual(
      [],
    );
    expect(rolesFromGroups(env, ['passbook_developers ', ' wallet_admins'])).toEqual([]);
    expect(rolesFromGroups(env, ['wallet_admin', 'walletadmins', 'passbook_developer'])).toEqual(
      [],
    );
  });

  it('grants nothing for unset variables', () => {
    expect(rolesFromGroups({}, ['wallet_admins', 'passbook_developers'])).toEqual([]);
    expect(rolesFromGroups({ OIDC_DEVELOPER_GROUP: '' }, [''])).toEqual([]);
  });

  it('grants nothing for a near miss and logs the group names only', () => {
    const warn = vi.fn();
    expect(rolesFromGroups(env, ['wallet-admins', 'Passbook_Developers'], { warn })).toEqual([]);
    expect(warn).toHaveBeenCalledWith('auth.oidc_group_near_miss', {
      code: 'GROUP_NEAR_MISS',
      received: 'wallet-admins',
      configured: 'wallet_admins',
    });
    expect(warn).toHaveBeenCalledWith('auth.oidc_group_near_miss', {
      code: 'GROUP_NEAR_MISS',
      received: 'Passbook_Developers',
      configured: 'passbook_developers',
    });
    warn.mockClear();
    expect(rolesFromGroups(env, ['wallet_admins'], { warn })).toHaveLength(4);
    expect(warn).not.toHaveBeenCalled();
  });

  describe('rename window: comma lists of exact names', () => {
    const both = {
      OIDC_PLATFORM_ADMIN_GROUP: 'wallet_admins,passbook_platform_admins',
      OIDC_ADMIN_GROUP: 'wallet_org_admins, passbook_console',
      OIDC_DEVELOPER_GROUP: 'passbook_developers',
      OIDC_USER_GROUP: 'wallet_users,passbook_users',
    };

    it('each alias grants its own variable role and no other', () => {
      for (const name of ['wallet_admins', 'passbook_platform_admins'])
        expect(rolesFromGroups(both, [name])).toEqual(['admin', 'user', 'developer', 'console']);
      for (const name of ['wallet_org_admins', 'passbook_console'])
        expect(rolesFromGroups(both, [name])).toEqual(['user', 'console']);
      for (const name of ['wallet_users', 'passbook_users'])
        expect(rolesFromGroups(both, [name])).toEqual(['user']);
    });

    it('matches each alias exactly and warns on a near miss of any alias', () => {
      const warn = vi.fn();
      expect(
        rolesFromGroups(both, ['passbook-console', 'passbook_platform_admin', 'Passbook_Users'], {
          warn,
        }),
      ).toEqual([]);
      expect(warn).toHaveBeenCalledWith('auth.oidc_group_near_miss', {
        code: 'GROUP_NEAR_MISS',
        received: 'passbook-console',
        configured: 'passbook_console',
      });
      expect(warn).toHaveBeenCalledWith('auth.oidc_group_near_miss', {
        code: 'GROUP_NEAR_MISS',
        received: 'Passbook_Users',
        configured: 'passbook_users',
      });
    });

    it('ignores empty entries; a lone comma grants nothing', () => {
      expect(rolesFromGroups({ OIDC_USER_GROUP: ',wallet_users,' }, ['wallet_users'])).toEqual([
        'user',
      ]);
      expect(rolesFromGroups({ OIDC_USER_GROUP: ',' }, [''])).toEqual([]);
    });
  });

  describe('OIDC_PLATFORM_ADMIN_SUBJECTS', () => {
    const pinned = { ...env, OIDC_PLATFORM_ADMIN_SUBJECTS: 'sub-a, sub-b' };

    it('empty or unset keeps the group-only behaviour', () => {
      expect(rolesFromGroups(env, ['wallet_admins'], undefined, 'anyone')).toContain('admin');
      expect(
        rolesFromGroups({ ...env, OIDC_PLATFORM_ADMIN_SUBJECTS: '' }, ['wallet_admins']),
      ).toContain('admin');
    });

    it('a listed subject in the group is admin', () => {
      expect(rolesFromGroups(pinned, ['wallet_admins'], undefined, 'sub-b')).toEqual([
        'admin',
        'user',
        'developer',
        'console',
      ]);
    });

    it('a group member who is not listed (or has no subject) is not admin and gets nothing implied', () => {
      expect(rolesFromGroups(pinned, ['wallet_admins'], undefined, 'sub-z')).toEqual([]);
      expect(rolesFromGroups(pinned, ['wallet_admins'])).toEqual([]);
      expect(
        rolesFromGroups(pinned, ['wallet_admins', 'wallet_users'], undefined, 'sub-z'),
      ).toEqual(['user']);
    });

    it('a listed subject outside the group is not admin', () => {
      expect(rolesFromGroups(pinned, ['wallet_users'], undefined, 'sub-a')).toEqual(['user']);
    });
  });

  describe('a name configured in more than one variable', () => {
    const dup = { ...env, OIDC_USER_GROUP: 'wallet_users,wallet_admins' };

    it('grants only the lowest role and warns with a stable code', () => {
      const warn = vi.fn();
      expect(rolesFromGroups(dup, ['wallet_admins'], { warn })).toEqual(['user']);
      expect(warn).toHaveBeenCalledWith('auth.oidc_group_duplicate', {
        code: 'GROUP_CONFIGURED_TWICE',
        configured: 'wallet_admins',
        variables: ['OIDC_USER_GROUP', 'OIDC_PLATFORM_ADMIN_GROUP'],
      });
    });

    it('leaves the other names alone and stays quiet when the claim lacks the name', () => {
      const warn = vi.fn();
      expect(rolesFromGroups(dup, ['wallet_org_admins'], { warn })).toEqual(['user', 'console']);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
