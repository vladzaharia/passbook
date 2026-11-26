import { describe, expect, it } from 'vitest';
import { adminNavGroups, firstAllowedPath, isActivePath, sectionLabel } from './nav.ts';
import { PLATFORM } from './scope.ts';
import { membershipFixture } from './test-utils.tsx';

const org = { kind: 'org', orgId: 'o1' } as const;
const labels = (groups: { label: string }[][]) => groups.map((g) => g.map((i) => i.label));

describe('admin navigation per scope', () => {
  it('lists the organization console for a member with every capability', () => {
    expect(labels(adminNavGroups(org, false, membershipFixture('o1')))).toEqual([
      ['Overview'],
      ['Passes', 'Templates', 'Blueprints', 'Connections'],
      ['Messages', 'Scanning', 'Test inbox'],
      ['Brand and channels', 'Members', 'API keys', 'Audit log', 'Retention', 'Plan', 'Settings'],
    ]);
    expect(adminNavGroups(org, false, membershipFixture('o1'))[1]?.[0]?.to).toBe(
      '/admin/o/o1/passes',
    );
  });

  it('adds Groups to the platform console only while Polaris ID is connected', () => {
    const flat = (polaris: boolean) =>
      adminNavGroups(PLATFORM, true, undefined, { polaris })
        .flat()
        .map((i) => i.label);
    expect(flat(false)).not.toContain('Groups');
    expect(flat(true)).toContain('Groups');
    expect(
      adminNavGroups(PLATFORM, true)
        .flat()
        .map((i) => i.label),
    ).not.toContain('Groups');
  });

  it('lists the platform console for a platform admin', () => {
    const groups = adminNavGroups(PLATFORM, true);
    expect(labels(groups)).toEqual([
      ['Overview'],
      ['Organizations', 'Users'],
      ['Status', 'Audit log', 'Retention'],
      ['Wallet accounts', 'API keys', 'Settings'],
    ]);
    expect(groups.flat().every((item) => item.to.startsWith('/admin/platform'))).toBe(true);
  });

  it('never shows platform pages to a member without platform rights', () => {
    expect(adminNavGroups(PLATFORM, false, membershipFixture('o1'))).toEqual([]);
  });

  it('shows a platform admin nothing of an organization they are not a member of', () => {
    expect(adminNavGroups(org, true)).toEqual([]);
    expect(adminNavGroups(org, true, membershipFixture('o2'))).toEqual([]);
  });

  it('filters organization pages by the membership capabilities', () => {
    const reader = membershipFixture('o1', { capabilities: ['org:read', 'passes:read'] });
    expect(labels(adminNavGroups(org, false, reader))).toEqual([
      ['Overview'],
      ['Passes'],
      ['Test inbox'],
      ['Brand and channels', 'Retention', 'Plan', 'Settings'],
    ]);
    const scanner = membershipFixture('o1', { capabilities: ['scanning:read'] });
    expect(firstAllowedPath(org, false, scanner)).toBe('/admin/o/o1/scanning');
    expect(firstAllowedPath(org, false, membershipFixture('o1', { capabilities: [] }))).toBe(
      undefined,
    );
  });

  it('has no navigation outside a scope', () => {
    expect(adminNavGroups(undefined, true, membershipFixture('o1'))).toEqual([]);
  });
});

describe('sectionLabel and isActivePath', () => {
  it('names sections in either scope', () => {
    expect(sectionLabel('/admin/o/o1/templates/t1')).toBe('Templates');
    expect(sectionLabel('/admin/o/o1')).toBe('Overview');
    expect(sectionLabel('/admin/platform/wallet-accounts/i1')).toBe('Wallet accounts');
    expect(sectionLabel('/admin/passes')).toBeUndefined();
  });

  it('matches a scope overview only exactly', () => {
    expect(isActivePath('/admin/o/o1', '/admin/o/o1')).toBe(true);
    expect(isActivePath('/admin/o/o1/passes', '/admin/o/o1')).toBe(false);
    expect(isActivePath('/admin/o/o1/passes/p1', '/admin/o/o1/passes')).toBe(true);
    expect(isActivePath('/admin/platform/users', '/admin/platform')).toBe(false);
    expect(isActivePath('/admin', '/admin')).toBe(true);
    expect(isActivePath('/admin/o/o1/passes', '/admin')).toBe(false);
  });
});
