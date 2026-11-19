import { describe, expect, it } from 'vitest';
import { type LegacyContext, legacyAdminTarget } from './legacy-admin.ts';
import { PLATFORM } from './scope.ts';
import { membershipFixture } from './test-utils.tsx';

const one: LegacyContext = { platformAdmin: false, memberships: [membershipFixture('o1')] };
const two: LegacyContext = {
  platformAdmin: false,
  memberships: [membershipFixture('o1'), membershipFixture('o2')],
};
const admin: LegacyContext = { platformAdmin: true, memberships: [membershipFixture('o1')] };
const go = (path: string, search: Record<string, unknown> = {}, ctx: LegacyContext = one) =>
  legacyAdminTarget(path, search, ctx) ?? { to: 'none', search: {} };

describe('legacy admin URLs', () => {
  // Every old console route, with the organization in ?orgId= where it had one.
  it.each([
    ['/admin/passes', '/admin/o/o1/passes'],
    ['/admin/passes/p1', '/admin/o/o1/passes/p1'],
    ['/admin/passes/new', '/admin/o/o1/passes/new'],
    ['/admin/passes/import', '/admin/o/o1/passes/import'],
    ['/admin/passes/import/i1', '/admin/o/o1/passes/import/i1'],
    ['/admin/templates', '/admin/o/o1/templates'],
    ['/admin/templates/t1', '/admin/o/o1/templates/t1'],
    ['/admin/templates/new', '/admin/o/o1/templates/new'],
    ['/admin/templates/upload', '/admin/o/o1/templates/upload'],
    ['/admin/templates/t1/design', '/admin/o/o1/templates/t1/design'],
    ['/admin/templates/t1/join-sign', '/admin/o/o1/templates/t1/join-sign'],
    ['/admin/blueprints', '/admin/o/o1/blueprints'],
    ['/admin/blueprints/b1', '/admin/o/o1/blueprints/b1'],
    ['/admin/connections', '/admin/o/o1/connections'],
    ['/admin/connections/new', '/admin/o/o1/connections/new'],
    ['/admin/connections/c1', '/admin/o/o1/connections/c1'],
    ['/admin/connections/webhooks/new', '/admin/o/o1/connections/webhooks/new'],
    ['/admin/connections/webhooks/w1', '/admin/o/o1/connections/webhooks/w1'],
    ['/admin/messages', '/admin/o/o1/messages'],
    ['/admin/messages/new', '/admin/o/o1/messages/new'],
    ['/admin/messages/m1', '/admin/o/o1/messages/m1'],
    ['/admin/scanning', '/admin/o/o1/scanning'],
    ['/admin/scanning/events/e1', '/admin/o/o1/scanning/events/e1'],
    ['/admin/scanning/scanners/s1', '/admin/o/o1/scanning/scanners/s1'],
    ['/admin/scanning/sessions/s1', '/admin/o/o1/scanning/sessions/s1'],
    ['/admin/test-inbox', '/admin/o/o1/test-inbox'],
    ['/admin/audit', '/admin/o/o1/audit'],
    ['/admin/api-keys', '/admin/o/o1/api-keys'],
    ['/admin', '/admin/o/o1'],
  ])('%s?orgId=o1 → %s', (path, to) => {
    expect(go(path, { orgId: 'o1', tab: 'x' }, two)).toEqual({ to, search: { tab: 'x' } });
  });

  it.each([
    ['/admin/orgs', '/admin/platform/orgs'],
    ['/admin/orgs/o1', '/admin/platform/orgs/o1'],
    ['/admin/users', '/admin/platform/users'],
    ['/admin/users/u1', '/admin/platform/users/u1'],
    ['/admin/status', '/admin/platform/status'],
    ['/admin/identities', '/admin/platform/wallet-accounts'],
    ['/admin/identities/i1', '/admin/platform/wallet-accounts/i1'],
    ['/admin/settings', '/admin/platform/settings'],
    ['/admin/audit', '/admin/platform/audit'],
    ['/admin/api-keys', '/admin/platform/api-keys'],
    ['/admin', '/admin/platform'],
  ])('%s → %s for a platform admin', (path, to) => {
    expect(go(path, { q: 'x' }, admin)).toEqual({ to, search: { q: 'x' } });
  });

  it('opens an organization workspace and the reply-to confirmation in its settings', () => {
    expect(go('/admin/orgs/o2', { view: 'workspace', orgId: 'o2' }, two)).toEqual({
      to: '/admin/o/o2/settings',
      search: {},
    });
    expect(go('/admin/orgs/north%2Fwest', { confirmReplyTo: 't' }, admin)).toEqual({
      to: '/admin/o/north%2Fwest/settings',
      search: { confirmReplyTo: 't' },
    });
  });

  it('sends an organization admin to their own settings, never a refusal', () => {
    expect(go('/admin/settings')).toEqual({ to: '/admin/o/o1/settings', search: {} });
  });

  it('keeps an explicit organization even without a membership: the gate refuses it', () => {
    expect(go('/admin/passes', { orgId: 'other' })).toEqual({
      to: '/admin/o/other/passes',
      search: {},
    });
  });

  it('uses this tab, then the remembered scope, then the only organization', () => {
    expect(go('/admin/passes', {}, { ...two, tab: { kind: 'org', orgId: 'o2' } }).to).toBe(
      '/admin/o/o2/passes',
    );
    expect(go('/admin/passes', {}, { ...two, remembered: { kind: 'org', orgId: 'o2' } }).to).toBe(
      '/admin/o/o2/passes',
    );
    expect(
      go(
        '/admin/passes',
        {},
        { ...two, tab: { kind: 'org', orgId: 'o1' }, remembered: { kind: 'org', orgId: 'o2' } },
      ).to,
    ).toBe('/admin/o/o1/passes');
    // A remembered organization the principal left is ignored.
    expect(go('/admin/passes', {}, { ...one, remembered: { kind: 'org', orgId: 'gone' } }).to).toBe(
      '/admin/o/o1/passes',
    );
  });

  it('asks which organization when several could open the section', () => {
    expect(go('/admin/passes', {}, two)).toEqual({ to: '/admin', search: { next: '/passes' } });
    expect(go('/admin', {}, two)).toEqual({ to: '/admin', search: {} });
  });

  it('opens a detail in any organization; the page then moves to its owner', () => {
    expect(go('/admin/passes/p1', {}, two).to).toBe('/admin/o/o1/passes/p1');
  });

  it('lets a platform admin return to the scope they had open', () => {
    expect(go('/admin', {}, { ...admin, remembered: { kind: 'org', orgId: 'o1' } }).to).toBe(
      '/admin/o/o1',
    );
    expect(go('/admin/audit', {}, { ...admin, tab: PLATFORM }).to).toBe('/admin/platform/audit');
    // Settings name the platform for a platform admin, whatever was open.
    expect(go('/admin/settings', {}, { ...admin, tab: { kind: 'org', orgId: 'o1' } }).to).toBe(
      '/admin/platform/settings',
    );
  });

  it('sends a platform admin without memberships to the platform, and ignores other paths', () => {
    const lone: LegacyContext = { platformAdmin: true, memberships: [] };
    expect(go('/admin/audit', {}, lone).to).toBe('/admin/platform/audit');
    expect(go('/admin/passes', {}, lone)).toEqual({ to: '/admin', search: { next: '/passes' } });
    expect(go('/admin/account')).toBeUndefined();
    expect(go('/admin/unknown')).toBeUndefined();
    expect(go('/admin/passes-extra')).toBeUndefined();
  });
});
