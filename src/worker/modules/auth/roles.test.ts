import { describe, expect, it } from 'vitest';
import { rolesFromGroups } from './service.ts';

const env = { OIDC_ADMIN_GROUP: 'wallet-admins', OIDC_USER_GROUP: 'wallet-users' };

describe('rolesFromGroups', () => {
  it('maps the configured groups', () => {
    expect(rolesFromGroups(env, ['wallet-admins'])).toEqual(['admin', 'user']);
    expect(rolesFromGroups(env, ['wallet-users'])).toEqual(['user']);
  });

  it("accepts the names Pocket ID generates from a group's display name", () => {
    expect(rolesFromGroups(env, ['wallet_admins'])).toEqual(['admin', 'user']);
    expect(rolesFromGroups(env, ['wallet_users'])).toEqual(['user']);
    expect(rolesFromGroups(env, ['Wallet Admins'])).toEqual(['admin', 'user']);
  });

  it('grants nothing for other groups or unset variables', () => {
    expect(rolesFromGroups(env, ['wallet-admin', 'admins', 'walletadmins'])).toEqual([]);
    expect(rolesFromGroups({}, ['wallet-admins'])).toEqual([]);
    expect(rolesFromGroups({ OIDC_ADMIN_GROUP: '' }, [''])).toEqual([]);
  });
});
