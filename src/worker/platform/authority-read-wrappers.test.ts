// Every statement here returns foreign rows for an absent actor when run raw, and `assertActorOnce` refuses it.
// The accepted forms are the builder's own outputs.
import { describe, expect, it } from 'vitest';
import { db } from './authority-ext-fixtures.ts';
import { authorityPredicate } from './authority-read.ts';
import { seed } from './authority-read-join-fixtures.ts';
import { assertActorOnce } from './authority-read-once.ts';
import { all } from './db.ts';

const ABSENT = { kind: 'api_key', keyId: 'no-such-key', scope: 'scans:read' } as const;

async function build() {
  const s = await seed();
  const p = authorityPredicate(ABSENT, { scope: 'platform', now: s.f.clock.now() });
  const A = p.anchor;
  const P = 'ao.authority_present_k7';
  const x = (a: string) => `${p.authorized(a)}`;
  // Each case is a complete statement over the absent actor; the CTE list may be extended with `extra`.
  const stmt = (body: string, extra = '') => `WITH ${p.ctes}${extra} ${body}`;
  const leaks = async (sql: string) => (await all(db, sql, p.params)).length;
  return { p, A, P, x, stmt, leaks };
}

describe('the absent-anchor read leaks nowhere once the guard is on', () => {
  type Ctx = Awaited<ReturnType<typeof build>>;
  const cases: [string, (c: Ctx) => string, RegExp][] = [
    [
      'rev-4 probe 1: NOT EXISTS over the anchor',
      (c) =>
        c.stmt(
          `SELECT x.id FROM passes x WHERE NOT EXISTS (SELECT 1 FROM ${c.A} WHERE ${c.P} = 1)`,
        ),
      /not in a subquery/,
    ],
    [
      'rev-4 probe 2: NOT EXISTS over the rows form',
      (c) =>
        c.stmt(
          `SELECT x.id FROM passes x WHERE NOT EXISTS (SELECT 1 FROM actor_ok ao WHERE ${c.P} = 1)`,
        ),
      /not in a subquery/,
    ],
    [
      'rev-4 probe 3: NOT IN over the anchor',
      (c) =>
        c.stmt(
          `SELECT x.id FROM passes x WHERE x.id NOT IN (SELECT 1 FROM ${c.A} WHERE ${c.P} = 1 AND 1 = 1)`,
        ),
      /not in a subquery/,
    ],
    [
      'rev-4 probe 4: scalar subquery of authorized() compared to 0',
      (c) => c.stmt(`SELECT x.id FROM passes x WHERE (SELECT ${c.x('authz')} FROM ${c.A}) = 0`),
      /not in a subquery/,
    ],
    [
      'rev-4 probe 5: a renamed authorized() alias read through a FROM sub-select',
      (c) =>
        c.stmt(
          `SELECT x.id FROM passes x CROSS JOIN (SELECT z.authz AS b FROM (SELECT ${c.x('authz')} FROM ${c.A}) z) y WHERE y.b = 0`,
        ),
      /not in a subquery/,
    ],
    [
      'star in the core',
      (c) =>
        c.stmt(
          `SELECT x.id FROM w CROSS JOIN passes x WHERE w.authority_present_k7 IS NOT 1`,
          `, w AS (SELECT * FROM ${c.A})`,
        ),
      /no \*|presence outside the ao core/,
    ],
    [
      'ao.* in the core',
      (c) =>
        c.stmt(
          `SELECT x.id FROM w CROSS JOIN passes x WHERE w.authority_present_k7 IS NOT 1`,
          `, w AS (SELECT ao.* FROM ${c.A})`,
        ),
      /no \*|presence outside the ao core/,
    ],
    [
      'unqualified anchor column in the core',
      (c) =>
        c.stmt(
          `SELECT x.id FROM w CROSS JOIN passes x WHERE w.authority_present_k7 IS NOT 1`,
          `, w AS (SELECT authority_present_k7 FROM ${c.A})`,
        ),
      /unqualified anchor column|presence outside the ao core/,
    ],
    [
      'UNION ALL arm',
      (c) =>
        c.stmt(
          `SELECT x.id FROM w CROSS JOIN passes x WHERE w.authz = 0`,
          `, w AS (SELECT ${c.x('authz')} FROM ${c.A} UNION ALL SELECT 1)`,
        ),
      /compound/,
    ],
    [
      'INTERSECT arm',
      (c) =>
        c.stmt(
          `SELECT x.id FROM w CROSS JOIN passes x WHERE w.authz = 0`,
          `, w AS (SELECT ${c.x('authz')} FROM ${c.A} INTERSECT SELECT 0)`,
        ),
      /compound/,
    ],
    [
      'EXCEPT arm',
      (c) =>
        c.stmt(
          `SELECT x.id FROM w CROSS JOIN passes x WHERE w.authz = 0`,
          `, w AS (SELECT ${c.x('authz')} FROM ${c.A} EXCEPT SELECT 1)`,
        ),
      /compound/,
    ],
    [
      'CTE column list',
      (c) =>
        c.stmt(
          `SELECT x.id FROM w CROSS JOIN passes x WHERE w.p = 0`,
          `, w(p) AS (SELECT ${c.x('authz')} FROM ${c.A})`,
        ),
      /column list/,
    ],
    [
      'FROM sub-select',
      (c) =>
        c.stmt(
          `SELECT x.id FROM passes x CROSS JOIN (SELECT ${c.x('authz')} FROM ${c.A}) w WHERE w.authz = 0`,
        ),
      /not in a subquery/,
    ],
    [
      'scalar subquery reading an anchor column',
      (c) => c.stmt(`SELECT x.id FROM passes x WHERE x.org_id != (SELECT ao.org_id FROM ${c.A})`),
      /joins actor_ok once|not in a subquery|compared with = only|select list/,
    ],
    [
      'NOT IN subquery over the stamp',
      (c) =>
        c.stmt(
          `SELECT x.id FROM passes x WHERE x.id NOT IN (SELECT x2.id FROM ${c.A} CROSS JOIN passes x2 WHERE ${c.P} = 1)`,
        ),
      /not in a subquery/,
    ],
    [
      'CTE alias renamed in the top-level list',
      (c) =>
        c.stmt(
          `SELECT page.authz AS b FROM page WHERE page.authz = 0`,
          `, page AS (SELECT ${c.x('authz')}, x.id FROM ${c.A} CROSS JOIN passes x)`,
        ),
      /alias|ao CTE|top-level/,
    ],
  ];

  it.each(cases)('%s', async (_n, build_, why) => {
    const c = await build();
    const sql = build_(c);
    // Without the guard the statement reads foreign rows for a key that does not exist.
    expect(await c.leaks(sql), 'leaks without the guard').toBeGreaterThan(0);
    expect(() => assertActorOnce(sql)).toThrow(why);
  });

  it('a plain presence gate returns no foreign row for the same absent actor', async () => {
    const c = await build();
    const sql = c.stmt(`SELECT x.id FROM ${c.A} CROSS JOIN passes x WHERE ${c.P} = 1`);
    expect(await c.leaks(sql)).toBe(0);
    expect(() => assertActorOnce(sql)).not.toThrow();
  });
});

describe('accepted forms of authorized()', () => {
  it.each([
    [
      'at top level',
      (c: Awaited<ReturnType<typeof build>>) => c.stmt(`SELECT ${c.x('authz')} FROM ${c.A}`),
    ],
    [
      'with a condition',
      (c: Awaited<ReturnType<typeof build>>) =>
        c.stmt(`SELECT ${c.p.authorized('authz', 'EXISTS (SELECT 1 FROM passes)')} FROM ${c.A}`),
    ],
    [
      'beside tenant columns',
      (c: Awaited<ReturnType<typeof build>>) =>
        c.stmt(`SELECT ${c.x('authz')}, x.id FROM ${c.A} LEFT JOIN passes x ON ${c.P} = 1`),
    ],
    [
      'in a top-level CTE read once and selected as page.*',
      (c: Awaited<ReturnType<typeof build>>) =>
        c.stmt(
          `SELECT page.* FROM page`,
          `, page AS (SELECT ${c.x('auth_ok')}, x.id FROM ${c.A} CROSS JOIN passes x WHERE ${c.P} = 1 LIMIT 5)`,
        ),
    ],
    [
      'in a top-level CTE read as page.alias in the select list',
      (c: Awaited<ReturnType<typeof build>>) =>
        c.stmt(
          `SELECT page.auth_ok, page.id FROM page`,
          `, page AS (SELECT ${c.x('auth_ok')}, x.id FROM ${c.A} CROSS JOIN passes x)`,
        ),
    ],
  ])('%s', async (_n, make) => {
    const c = await build();
    expect(() => assertActorOnce(make(c))).not.toThrow();
  });
});
