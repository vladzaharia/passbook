import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { knownPlaceholders } from './resolve.ts';
import { loadRoutes, placeholdersOf } from './routes.ts';

const root = resolve(import.meta.dirname, '../../..');
const lists = ['admin', 'portal', 'public', 'scanner', 'scanning', 'workbench'].flatMap((n) =>
  loadRoutes(resolve(root, `tools/dev/visual-routes/${n}.json`)),
);
const shape = (path: string) =>
  path
    .replace(/\?.*$/, '')
    .replace(/\{[A-Za-z]+\}|\$[A-Za-z]+/g, '{}')
    .replace(/(.)\/$/, '$1');

describe('visual sweep coverage', () => {
  it('lists every SPA route in routeTree.gen.ts', () => {
    const tree = readFileSync(resolve(root, 'src/web/routeTree.gen.ts'), 'utf8');
    const block = /interface FileRoutesByFullPath \{([^}]*)\}/.exec(tree)?.[1] ?? '';
    const routes = [...block.matchAll(/'([^']+)':/g)].map((m) => shape(m[1] as string));
    expect(routes.length).toBeGreaterThan(30);
    const listed = new Set(lists.map((r) => shape(r.path)));
    expect(routes.filter((r) => !listed.has(r))).toEqual([]);
  });

  it('has a resolver for every placeholder', () => {
    const known = new Set(knownPlaceholders());
    const used = new Set(
      lists.flatMap((r) => [...placeholdersOf(r.path), ...(r.filterOrg ? [r.filterOrg] : [])]),
    );
    expect([...used].filter((p) => !known.has(p))).toEqual([]);
  });
});
