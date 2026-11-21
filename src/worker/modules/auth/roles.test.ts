import { describe, expect, it } from 'vitest';
import { rolesFromGroups } from './service.ts';

const env = {
  OIDC_PLATFORM_ADMIN_GROUP: 'wallet-admins',
  OIDC_ADMIN_GROUP: 'wallet-org-admins',
  OIDC_DEVELOPER_GROUP: 'passbook-developers',
  OIDC_USER_GROUP: 'wallet-users',
};

describe('rolesFromGroups', () => {
  it('maps each configured group to its roles', () => {
    expect(rolesFromGroups(env, ['wallet-admins'])).toEqual(['admin', 'user', 'developer']);
    expect(rolesFromGroups(env, ['wallet-org-admins'])).toEqual(['user']);
    expect(rolesFromGroups(env, ['passbook-developers'])).toEqual(['user', 'developer']);
    expect(rolesFromGroups(env, ['wallet-users'])).toEqual(['user']);
  });

  it('combines groups, platform admin implying developer', () => {
    expect(rolesFromGroups(env, ['wallet-users', 'passbook-developers'])).toEqual([
      'user',
      'developer',
    ]);
    expect(rolesFromGroups(env, ['passbook-developers', 'wallet-admins'])).toEqual([
      'admin',
      'user',
      'developer',
    ]);
  });

  it("accepts the underscore form Pocket ID can give a group's claim name", () => {
    expect(rolesFromGroups(env, ['passbook_developers'])).toEqual(['user', 'developer']);
    expect(rolesFromGroups(env, ['wallet_admins'])).toEqual(['admin', 'user', 'developer']);
  });

  it('matches names exactly, case included', () => {
    expect(rolesFromGroups(env, ['Passbook-Developers', 'PASSBOOK_DEVELOPERS'])).toEqual([]);
    expect(rolesFromGroups(env, ['Wallet Admins', 'wallet-admin', 'walletadmins'])).toEqual([]);
    expect(rolesFromGroups(env, ['passbook-developers ', 'passbook-developer'])).toEqual([]);
  });

  it('grants nothing for unset variables', () => {
    expect(rolesFromGroups({}, ['wallet-admins', 'passbook-developers'])).toEqual([]);
    expect(rolesFromGroups({ OIDC_DEVELOPER_GROUP: '' }, [''])).toEqual([]);
  });
});
