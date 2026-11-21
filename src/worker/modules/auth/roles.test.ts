import { describe, expect, it } from 'vitest';
import { rolesFromGroups } from './service.ts';

const env = { OIDC_ADMIN_GROUP: 'wallet-admins', OIDC_USER_GROUP: 'wallet-users' };

describe('rolesFromGroups', () => {
  it('maps the configured groups', () => {
    expect(rolesFromGroups(env, ['wallet-admins'])).toEqual(['admin', 'user']);
    expect(rolesFromGroups(env, ['wallet-users'])).toEqual(['user']);
  });

  it('matches exactly: case, prefix, suffix and punctuation variants grant nothing', () => {
    for (const near of [
      'wallet_admins',
      'Wallet Admins',
      'Wallet-Admins',
      'wallet-admins ',
      'wallet-admins-extra',
      'x-wallet-admins',
      'wallet.admins',
    ])
      expect(rolesFromGroups(env, [near]), near).toEqual([]);
  });

  it('takes a comma-separated list of exact names', () => {
    const both = {
      OIDC_ADMIN_GROUP: 'wallet-admins, wallet_admins',
      OIDC_USER_GROUP: 'wallet-users',
    };
    expect(rolesFromGroups(both, ['wallet_admins'])).toEqual(['admin', 'user']);
    expect(rolesFromGroups(both, ['wallet-admins'])).toEqual(['admin', 'user']);
    expect(rolesFromGroups(both, ['wallet'])).toEqual([]);
  });

  it('grants nothing for other groups or unset variables', () => {
    expect(rolesFromGroups(env, ['wallet-admin', 'admins', 'walletadmins'])).toEqual([]);
    expect(rolesFromGroups({}, ['wallet-admins'])).toEqual([]);
    expect(rolesFromGroups({ OIDC_ADMIN_GROUP: '' }, [''])).toEqual([]);
  });
});
