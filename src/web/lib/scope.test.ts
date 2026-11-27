import { describe, expect, it } from 'vitest';
import {
  ALL,
  allPath,
  orgPath,
  PLATFORM,
  parseAdminPath,
  parseScopeKey,
  scopeKey,
  sectionOf,
  switchTarget,
  withOrg,
} from './scope.ts';

describe('parseAdminPath', () => {
  it('reads the platform and organization scopes and the path inside them', () => {
    expect(parseAdminPath('/admin/platform')).toEqual({ scope: PLATFORM, rest: '' });
    expect(parseAdminPath('/admin/platform/users/u1/')).toEqual({
      scope: PLATFORM,
      rest: '/users/u1',
    });
    expect(parseAdminPath('/admin/o/o1')).toEqual({
      scope: { kind: 'org', orgId: 'o1' },
      rest: '',
    });
    expect(parseAdminPath('/admin/o/north%2Fwest/passes/p1')).toEqual({
      scope: { kind: 'org', orgId: 'north/west' },
      rest: '/passes/p1',
    });
  });

  it('leaves unscoped, legacy and malformed paths without a scope', () => {
    for (const path of [
      '/admin',
      '/admin/account',
      '/admin/passes',
      '/admin/platformx',
      '/admin/o',
    ]) {
      expect(parseAdminPath(path).scope, path).toBeUndefined();
    }
    expect(parseAdminPath('/admin/o/%E0%A4%A/passes').scope).toBeUndefined();
  });

  it('builds paths that parse back to the same organization', () => {
    const path = orgPath('north/west', '/settings');
    expect(path).toBe('/admin/o/north%2Fwest/settings');
    expect(parseAdminPath(path).scope).toEqual({ kind: 'org', orgId: 'north/west' });
    expect(withOrg('/admin/o/o1/passes/p1', 'o2')).toBe('/admin/o/o2/passes/p1');
    expect(withOrg('/admin/platform/users', 'o2')).toBeUndefined();
  });

  it('stores scopes as keys and rejects anything else', () => {
    expect(parseScopeKey(scopeKey(PLATFORM))).toEqual(PLATFORM);
    expect(parseScopeKey(scopeKey({ kind: 'org', orgId: 'o1' }))).toEqual({
      kind: 'org',
      orgId: 'o1',
    });
    for (const raw of [undefined, null, '', 'org:', 'o1', `org:${'x'.repeat(101)}`]) {
      expect(parseScopeKey(raw), String(raw)).toBeUndefined();
    }
  });

  it('names the top-level section', () => {
    expect(sectionOf('')).toBe('');
    expect(sectionOf('/passes')).toBe('/passes');
    expect(sectionOf('/passes/p1/x')).toBe('/passes');
  });
});

describe('switchTarget', () => {
  const all = () => true;

  it('keeps the section between organizations, dropping details', () => {
    expect(switchTarget('/admin/o/o1/passes/p1', { kind: 'org', orgId: 'o2' }, all)).toBe(
      '/admin/o/o2/passes',
    );
    expect(switchTarget('/admin/o/o1/scanning', { kind: 'org', orgId: 'o2' }, all)).toBe(
      '/admin/o/o2/scanning',
    );
  });

  it('keeps a creation page, so the pass wizard can change its organization', () => {
    expect(switchTarget('/admin/o/o1/passes/new', { kind: 'org', orgId: 'o2' }, all)).toBe(
      '/admin/o/o2/passes/new',
    );
    expect(
      switchTarget(
        '/admin/o/o1/passes/new',
        { kind: 'org', orgId: 'o2' },
        (p) => !p.endsWith('/new'),
      ),
    ).toBe('/admin/o/o2/passes');
  });

  it('keeps sections both scopes have when moving to and from the platform', () => {
    for (const section of ['', '/audit', '/api-keys', '/settings']) {
      expect(switchTarget(`/admin/o/o1${section}`, PLATFORM, all)).toBe(
        `/admin/platform${section}`,
      );
      expect(switchTarget(`/admin/platform${section}`, { kind: 'org', orgId: 'o1' }, all)).toBe(
        `/admin/o/o1${section}`,
      );
    }
  });

  it('opens the overview when the target has no such section', () => {
    expect(switchTarget('/admin/o/o1/passes', PLATFORM, all)).toBe('/admin/platform');
    expect(switchTarget('/admin/platform/status', { kind: 'org', orgId: 'o1' }, all)).toBe(
      '/admin/o/o1',
    );
    // Members (organization) and Users (platform) are counterparts; Members arrives later.
    expect(
      switchTarget('/admin/platform/users/u1', { kind: 'org', orgId: 'o1' }, (p) =>
        p.endsWith('/o1'),
      ),
    ).toBe('/admin/o/o1');
  });

  it('falls back to the first allowed page when neither the section nor the overview is', () => {
    const target = { kind: 'org', orgId: 'o2' } as const;
    const only = (path: string) => path === '/admin/o/o2/templates';
    expect(switchTarget('/admin/o/o1/passes', target, only, '/admin/o/o2/templates')).toBe(
      '/admin/o/o2/templates',
    );
    expect(switchTarget('/admin/account', target, all)).toBe('/admin/o/o2');
  });
});

describe('the All scope', () => {
  it('parses and formats /admin/all/passes', () => {
    expect(parseAdminPath('/admin/all/passes')).toEqual({ scope: ALL, rest: '/passes' });
    expect(parseAdminPath('/admin/all')).toEqual({ scope: ALL, rest: '' });
    expect(parseAdminPath('/admin/allx')).toEqual({ rest: '/admin/allx' });
    expect(allPath('/passes')).toBe('/admin/all/passes');
    expect(scopeKey(ALL)).toBe('all');
    expect(parseScopeKey('all')).toEqual(ALL);
  });

  it('always lands on Passes when the target is All', () => {
    for (const from of ['/admin/o/o1/templates', '/admin/platform/users', '/admin/o/o1']) {
      expect(switchTarget(from, ALL, () => false)).toBe('/admin/all/passes');
    }
  });

  it('keeps Passes leaving All for an organization, and opens the platform overview', () => {
    const org = { kind: 'org', orgId: 'o1' } as const;
    expect(switchTarget('/admin/all/passes', org, () => true)).toBe('/admin/o/o1/passes');
    expect(switchTarget('/admin/all/passes', PLATFORM, () => true)).toBe('/admin/platform');
  });
});
