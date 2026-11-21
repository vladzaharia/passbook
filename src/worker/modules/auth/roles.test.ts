import { describe, expect, it } from 'vitest';
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
});
