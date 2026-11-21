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
    expect(rolesFromGroups(env, ['wallet-admins'])).toEqual([
      'admin',
      'user',
      'developer',
      'console',
    ]);
    expect(rolesFromGroups(env, ['wallet-org-admins'])).toEqual(['user', 'console']);
    expect(rolesFromGroups(env, ['passbook-developers'])).toEqual(['user', 'developer']);
    expect(rolesFromGroups(env, ['wallet-users'])).toEqual(['user']);
  });

  it('combines groups, platform admin implying developer and console', () => {
    expect(rolesFromGroups(env, ['wallet-users', 'passbook-developers'])).toEqual([
      'user',
      'developer',
    ]);
    expect(rolesFromGroups(env, ['passbook-developers', 'wallet-org-admins'])).toEqual([
      'user',
      'developer',
      'console',
    ]);
  });

  it('matches names exactly: no case folding, no normalised form, no trimming', () => {
    expect(rolesFromGroups(env, ['passbook_developers'])).toEqual([]);
    expect(rolesFromGroups(env, ['wallet_admins', 'Wallet Admins', 'wallet_users'])).toEqual([]);
    expect(rolesFromGroups(env, ['Passbook-Developers', 'passbook-developers '])).toEqual([]);
    expect(rolesFromGroups(env, ['wallet-admin', 'walletadmins', 'passbook-developer'])).toEqual(
      [],
    );
    expect(
      rolesFromGroups({ OIDC_DEVELOPER_GROUP: 'passbook_developers' }, ['passbook_developers']),
    ).toEqual(['user', 'developer']);
  });

  it('grants nothing for unset variables', () => {
    expect(rolesFromGroups({}, ['wallet-admins', 'passbook-developers'])).toEqual([]);
    expect(rolesFromGroups({ OIDC_DEVELOPER_GROUP: '' }, [''])).toEqual([]);
  });
});
