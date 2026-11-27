import { Hono } from 'hono';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fakeAuth } from '../../../test/helpers/fake-auth.ts';
import { createApp } from '../app.ts';
import { isWholeMount, patternOf, scopedOwns, scopedRouter } from './router-scope.ts';

type Block = { host: unknown; mount: string; start: number; end: number };

const blocks: Block[] = [];
const realRoute = Hono.prototype.route;

beforeAll(() => {
  Hono.prototype.route = function (this: Hono, path: string, sub: Hono) {
    const start = this.routes.length;
    const out = realRoute.call(this, path, sub);
    blocks.push({ host: this, mount: path, start, end: this.routes.length });
    return out;
  } as typeof Hono.prototype.route;
});
afterAll(() => {
  Hono.prototype.route = realRoute;
});

const matcher = (pattern: string): RegExp => {
  const body = pattern
    .replace(/[.+?^$()|[\]\\]/g, '\\$&')
    .replace(/:[A-Za-z0-9_]+\{([^}]*)\}/g, '$1')
    .replace(/:[A-Za-z0-9_]+/g, '[^/]+')
    .replace(/\/\*$/, '(?:/.*)?')
    .replace(/\*/g, '.*');
  return new RegExp(`^${body}$`);
};
const concrete = (path: string) =>
  path.replace(/:[A-Za-z0-9_]+(\{[^}]*\})?/g, 'x').replace(/\*/g, 'x');

// Hono runs a router's `use('*', ...)` for every later route under its mount path, so on a shared
// prefix it reaches other routers' routes. A middleware meant for the whole mount is marked with
// wholeMountUse.
it('a router middleware never runs for another router routes', () => {
  const app = createApp({ stores: fakeAuth().stores });
  const top = blocks.filter((b) => b.host === app).sort((a, b) => a.start - b.start);
  const leaks: string[] = [];
  const routes = app.routes;
  for (const block of top) {
    for (let i = block.start; i < block.end; i += 1) {
      const mw = routes[i];
      if (mw?.method !== 'ALL' || !mw.path.endsWith('*')) continue;
      if (isWholeMount(mw.handler)) continue;
      const re = matcher(mw.path);
      for (const other of top) {
        if (other === block || other.start < block.end) continue;
        for (let j = other.start; j < other.end; j += 1) {
          const r = routes[j];
          if (!r || r.method === 'ALL') continue;
          if (!re.test(concrete(r.path))) continue;
          const base = mw.path.endsWith('/*') ? mw.path.slice(0, -2) : '';
          if (scopedOwns(mw.handler, base, r.method, concrete(r.path)) === false) continue;
          leaks.push(
            `middleware ${mw.path} (router at ${block.mount}) also runs for ${r.method} ${r.path} (router at ${other.mount}); scope it with ownUse/guard from platform/router-scope.ts`,
          );
        }
      }
    }
  }
  expect([...new Set(leaks)]).toEqual([]);
});

// A scoped middleware that fails to recognise one of its own routes skips it, and the route loses
// the guard. Every route registered after a scoped middleware on its router must be owned by it.
it('a scoped middleware runs for every own route registered after it', () => {
  const app = createApp({ stores: fakeAuth().stores });
  const missed: string[] = [];
  let checked = 0;
  for (const mw of app.routes) {
    const router = scopedRouter(mw.handler);
    if (!router) continue;
    const at = router.routes.findIndex((r) => r.handler === mw.handler);
    for (const r of router.routes.slice(at + 1)) {
      if (r.method === 'ALL') continue;
      checked += 1;
      if (scopedOwns(mw.handler, '', r.method, concrete(r.path)) === true) continue;
      missed.push(`${r.method} ${r.path}`);
    }
  }
  expect(checked).toBeGreaterThan(1000);
  expect([...new Set(missed)]).toEqual([]);
});

it('patternOf reads every Hono param form', () => {
  expect(patternOf('/a/:id').test('/a/x')).toBe(true);
  expect(patternOf('/a/:id').test('/a/x/y')).toBe(false);
  const typed = patternOf('/a/:id{[0-9]+}/b');
  expect(typed.test('/a/12/b')).toBe(true);
  expect(typed.test('/a/xy/b')).toBe(false);
  const optional = patternOf('/a/:id?');
  expect(optional.test('/a')).toBe(true);
  expect(optional.test('/a/x')).toBe(true);
  expect(optional.test('/a/x/y')).toBe(false);
  expect(patternOf('/a/:id{[a-z]+}?').test('/a/ab')).toBe(true);
  expect(patternOf('/a/*').test('/a/x/y')).toBe(true);
  expect(patternOf('/a.b').test('/aXb')).toBe(false);
});

it('patternOf throws on a pattern it cannot read, so a route cannot silently lose its guard', () => {
  expect(() => patternOf('/a/:id{[0-9]+')).toThrow();
  expect(() => patternOf('/a/b?')).toThrow();
  expect(() => patternOf('/a/{x}')).toThrow();
});
