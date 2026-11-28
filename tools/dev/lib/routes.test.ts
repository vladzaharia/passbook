import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fillPath,
  filterRoutes,
  parseRoutes,
  placeholdersOf,
  type Route,
  shotName,
  withCompanions,
} from './routes.ts';

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

  it('keeps the scanning capture gaps listed, each click a string or a list', () => {
    const file = resolve(import.meta.dirname, '../visual-routes/scanning.json');
    const routes = parseRoutes(readFileSync(file, 'utf8'));
    const names = routes.map((r) => r.name);
    for (const n of [
      'scan-admin-designer-dark',
      'scan-admin-designer-role-manager',
      'scan-admin-designer-state-refused',
      'scan-admin-new-zone-dialog',
      'scan-admin-session-dates',
      'scan-admin-scan-row-detail',
      'scan-admin-template-channels',
    ])
      expect(names).toContain(n);
    expect(new Set(names).size).toBe(names.length);
    const bad = routes.filter((r) => r.click !== undefined && ![r.click].flat().every(Boolean));
    expect(bad).toEqual([]);
  });

  it('adds scanner.json to a scanning run', () => {
    const d = 'tools/dev/visual-routes';
    expect(withCompanions([`${d}/scanning.json`])).toEqual([
      `${d}/scanning.json`,
      `${d}/scanner.json`,
    ]);
    const both = [`${d}/scanner.json`, `${d}/scanning.json`];
    expect(withCompanions(both)).toEqual(both);
    expect(withCompanions([`${d}/admin.json`])).toEqual([`${d}/admin.json`]);
  });

  it('validates click', () => {
    const one = (click: unknown) =>
      parseRoutes(JSON.stringify([{ role: 'org', path: '/a', name: 'n', click }]));
    expect(one(['x', 'y'])).toHaveLength(1);
    expect(one('x')).toHaveLength(1);
    for (const bad of [5, [1, {}], '', []]) expect(() => one(bad)).toThrow(/\/a.*click/);
  });

  it('validates mock and matches a whole name with =', () => {
    const one = (mock: unknown) =>
      parseRoutes(JSON.stringify([{ role: 'org', path: '/a', name: 'n', mock }]));
    expect(
      one([{ path: '/api/v1/passes', status: 429, headers: { 'retry-after': '5' } }]),
    ).toHaveLength(1);
    for (const bad of ['x', [], [{ path: 'api' }], [{}]])
      expect(() => one(bad)).toThrow(/\/a.*mock/);
    const rs = [{ name: 'a' }, { name: 'a-empty' }] as Route[];
    expect(filterRoutes(rs, '=a')).toHaveLength(1);
    expect(filterRoutes(rs, 'a')).toHaveLength(2);
  });
});
