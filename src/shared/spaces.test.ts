import { describe, expect, it } from 'vitest';
import { canUseSpace, type SignInMethod, SPACES, type Space, type SpaceAccess } from './spaces.ts';

const usable = (access: SpaceAccess): Space[] => SPACES.filter((s) => canUseSpace(s, access));
const access = (amr: SignInMethod, roles: string[] = ['user'], orgMember = false): SpaceAccess => ({
  amr,
  roles,
  orgMember,
});

describe('canUseSpace', () => {
  it('hides Admin from a Polaris ID member without the console role when the group is required', () => {
    const member = (roles: string[], amr: SignInMethod = 'oidc'): SpaceAccess => ({
      ...access(amr, roles, true),
      consoleGroupRequired: true,
    });
    expect(usable(member(['user']))).toEqual(['passes', 'account']);
    expect(usable(member(['user', 'console']))).toContain('admin');
    expect(usable(member(['admin', 'user']))).toContain('admin');
    expect(usable({ ...member(['user']), consoleGroupRequired: false })).toContain('admin');
  });

  it('gives a holder My passes and Account', () => {
    expect(usable(access('oidc'))).toEqual(['passes', 'account']);
  });

  it('adds Admin and the Workbench for an organization member, the Workbench and Developers for a developer', () => {
    expect(usable(access('oidc', ['user'], true))).toEqual([
      'passes',
      'account',
      'admin',
      'workbench',
    ]);
    expect(usable(access('oidc', ['user', 'developer']))).toEqual([
      'passes',
      'account',
      'workbench',
      'developers',
    ]);
  });

  it('opens the Workbench to Polaris ID only, and an org-only member needs the console group', () => {
    const required = { consoleGroupRequired: true };
    expect(canUseSpace('workbench', { ...access('oidc', ['user'], true), ...required })).toBe(
      false,
    );
    expect(
      canUseSpace('workbench', { ...access('oidc', ['user', 'console'], true), ...required }),
    ).toBe(true);
    // Their own sandbox needs no console group (design §2.3, check 10).
    expect(
      canUseSpace('workbench', { ...access('oidc', ['user', 'developer']), ...required }),
    ).toBe(true);
    expect(canUseSpace('workbench', access('breakglass', ['admin', 'user'], true))).toBe(false);
    expect(canUseSpace('workbench', access('magic_link', ['developer', 'user'], true))).toBe(false);
  });

  it('gives a platform admin every space, Developers implied', () => {
    expect(usable(access('oidc', ['admin', 'user']))).toEqual([
      'passes',
      'account',
      'admin',
      'workbench',
      'developers',
    ]);
  });

  it('gives an email link the holder spaces only, whatever the roles', () => {
    expect(usable(access('magic_link', ['admin', 'developer', 'user'], true))).toEqual([
      'passes',
      'account',
    ]);
  });

  it('gives break-glass Admin and not Developers', () => {
    expect(usable(access('breakglass', ['admin', 'user']))).toEqual(['passes', 'account', 'admin']);
  });
});
