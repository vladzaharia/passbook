import { describe, expect, it } from 'vitest';
import { fillPath, filterRoutes, parseRoutes, placeholdersOf, shotName } from './routes.ts';

describe('visual-sweep routes', () => {
  it('lists the placeholders in a path', () => {
    expect(placeholdersOf('/admin/passes/{passId}/x/{templateId}')).toEqual([
      'passId',
      'templateId',
    ]);
    expect(placeholdersOf('/admin')).toEqual([]);
  });

  it('fills placeholders and skips when one is missing', () => {
    expect(fillPath('/admin/passes/{passId}', { passId: 'abc' })).toBe('/admin/passes/abc');
    expect(fillPath('/p/{token}', { token: 'a/b' })).toBe('/p/a%2Fb');
    expect(fillPath('/admin/passes/{passId}', {})).toBeUndefined();
    expect(fillPath('/admin', {})).toBe('/admin');
  });

  it('names files by route, viewport and theme', () => {
    expect(shotName('Admin: Overview!', 'mobile', 'dark')).toBe('admin-overview-mobile-dark.png');
    expect(shotName('///', 'desktop', 'light')).toBe('page-desktop-light.png');
  });

  it('validates the list and filters by name substring', () => {
    const routes = parseRoutes(
      JSON.stringify([
        { role: 'org', path: '/admin', name: 'admin-overview' },
        { role: 'holder', path: '/', name: 'portal-passes' },
      ]),
    );
    expect(filterRoutes(routes, 'portal').map((r) => r.name)).toEqual(['portal-passes']);
    expect(filterRoutes(routes)).toHaveLength(2);
    expect(() => parseRoutes('[{"role":"x","path":"/a","name":"n"}]')).toThrow(/role/);
    expect(() => parseRoutes('{}')).toThrow(/array/);
  });
});
