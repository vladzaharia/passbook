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
    [
      'LEFT JOIN of the anchor read by ao.org_id IS NULL, ON <P> = 1',
      (c) =>
        c.stmt(
          `SELECT x.id FROM passes x LEFT JOIN ${c.A} ON ${c.P} = 1 AND 1 WHERE ao.org_id IS NULL`,
        ),
      /inner-join|joins actor_ok once|misplaced/,
    ],
    [
      'LEFT JOIN of the anchor on the tenant column',
      (c) =>
        c.stmt(
          `SELECT x.id FROM passes x LEFT JOIN ${c.A} ON x.org_id = ao.org_id WHERE ao.org_id IS NULL`,
        ),
      /inner-join|joins actor_ok once|misplaced/,
    ],
    [
      'RIGHT JOIN of the passes onto the anchor',
      (c) =>
        c.stmt(
          `SELECT x.id FROM ${c.A} RIGHT JOIN passes x ON ${c.P} = 1 AND x.org_id = ao.org_id WHERE ao.org_id IS NULL`,
        ),
      /inner-join|joins actor_ok once|misplaced/,
    ],
    [
      'LEFT JOIN of the rows form',
      (c) =>
        c.stmt(
          `SELECT x.id FROM passes x LEFT JOIN actor_ok ao CROSS JOIN passes k WHERE ao.org_id IS NULL`,
        ),
      /inner-join|joins actor_ok once|misplaced/,
    ],
    [
      'LEFT JOIN of a CTE that reads the anchor',
      (c) =>
        c.stmt(
          `SELECT x.id FROM passes x LEFT JOIN page ON 1 = 1 WHERE page.k IS NULL`,
          `, page AS (SELECT 1 AS k FROM ${c.A} WHERE ${c.P} = 1)`,
        ),
      /inner-join|joins actor_ok once|misplaced/,
    ],
    [
      'rev-1 negation: (x.org_id = ao.org_id) IS NOT 1',
      (c) =>
        c.stmt(`SELECT x.id FROM ${c.A} CROSS JOIN passes x WHERE (x.org_id = ao.org_id) IS NOT 1`),
      /appear only as|needs WHERE\/ON/,
    ],
    [
      'rev-1 negation: CASE THEN 0 ELSE 1 on the org comparison',
      (c) =>
        c.stmt(
          `SELECT x.id FROM ${c.A} CROSS JOIN passes x WHERE CASE WHEN x.org_id = ao.org_id THEN 0 ELSE 1 END = 1`,
        ),
      /appear only as|needs WHERE\/ON/,
    ],
    [
      'top-level OR after the stamp gate and ao.org_id IS NULL',
      (c) =>
        c.stmt(
          `SELECT x.id FROM ${c.A} CROSS JOIN passes x WHERE ${c.P} = 1 AND ao.org_id IS NULL OR x.id > 0`,
        ),
      /no OR|OR over ao|needs WHERE\/ON/,
    ],
    [
      'top-level OR with no stamp gate on ao.org_id IS NULL',
      (c) =>
        c.stmt(`SELECT x.id FROM ${c.A} CROSS JOIN passes x WHERE ao.org_id IS NULL OR x.id > 0`),
      /no OR|OR over ao|needs WHERE\/ON/,
    ],
    [
      'top-level OR after the tenant comparison',
      (c) =>
        c.stmt(
          `SELECT x.id FROM ${c.A} CROSS JOIN passes x WHERE x.org_id = ao.org_id OR x.id > 0`,
        ),
      /no OR|OR over ao|needs WHERE\/ON/,
    ],
    [
      'parenthesised OR over ao.* without the stamp gate',
      (c) =>
        c.stmt(
          `SELECT x.id FROM ${c.A} CROSS JOIN passes x WHERE (ao.org_id IS NULL OR x.id > 0) AND x.id IS NOT NULL`,
        ),
      /no OR|OR over ao|needs WHERE\/ON/,
    ],
    [
      'anchor column compared with another anchor column as the gate',
      (c) =>
        c.stmt(
          `SELECT x.id FROM ${c.A} CROSS JOIN passes x WHERE ao.mode = ao.org_id AND x.id > 0`,
        ),
      /needs WHERE\/ON|OR over ao|only as/,
    ],
    [
      'anchor column compared with another anchor column in a parenthesised OR',
      (c) =>
        c.stmt(
          `SELECT x.id FROM ${c.A} CROSS JOIN passes x WHERE ao.mode = ao.org_id AND (ao.limit_key IS NULL OR x.id > 0)`,
        ),
      /needs WHERE\/ON|OR over ao|only as/,
    ],
    [
      'holder with no filter at all',
      (c) => c.stmt(`SELECT x.id FROM ${c.A} CROSS JOIN passes x`),
      /needs WHERE\/ON/,
    ],
    [
      'holder with a filter that never mentions the anchor',
      (c) => c.stmt(`SELECT x.id FROM ${c.A} CROSS JOIN passes x WHERE x.id > 0`),
      /needs WHERE\/ON/,
    ],
    [
      'holder CTE with no anchor gate',
      (c) =>
        c.stmt(
          `SELECT x.id FROM page x`,
          `, page AS (SELECT x.id FROM ${c.A} CROSS JOIN passes x WHERE x.id > 0)`,
        ),
      /needs WHERE\/ON/,
    ],
    [
      'gate only in the ON of a LEFT JOIN',
      (c) =>
        c.stmt(
          `SELECT x.id FROM ${c.A} CROSS JOIN passes x LEFT JOIN passes y ON y.org_id = ao.org_id WHERE x.id > 0`,
        ),
      /needs WHERE\/ON/,
    ],
  ];

  it.each(cases)('%s', async (_n, build_, why) => {
    const c = await build();
    const sql = build_(c);
    // Without the guard the statement reads foreign rows for a key that does not exist.
    expect(await c.leaks(sql), 'leaks without the guard').toBeGreaterThan(0);
    expect(() => assertActorOnce(sql)).toThrow(why);
  });

  it('accepts a parenthesised OR that does not involve ao.* beside the stamp gate', async () => {
    const c = await build();
    const sql = c.stmt(
      `SELECT x.id FROM ${c.A} CROSS JOIN passes x WHERE ${c.P} = 1 AND (x.id > 0 OR x.id = 'k')`,
    );
    expect(await c.leaks(sql)).toBe(0);
    expect(() => assertActorOnce(sql)).not.toThrow();
  });

  it('accepts a parenthesised OR over ao.* when the stamp gate is a top-level AND term', async () => {
    const c = await build();
    const sql = c.stmt(
      `SELECT x.id FROM ${c.A} CROSS JOIN passes x WHERE ${c.P} = 1 AND (ao.limit_key IS NULL OR x.org_id = ao.org_id)`,
    );
    expect(await c.leaks(sql)).toBe(0);
    expect(() => assertActorOnce(sql)).not.toThrow();
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
        c.stmt(`SELECT ${c.x('authz')}, x.id FROM ${c.A} JOIN passes x ON ${c.P} = 1`),
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
