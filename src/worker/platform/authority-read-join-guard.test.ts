// The guard (`assertActorOnce`) fails closed on every re-reference SQLite resolves to the CTE, the platform
// term needs `present`, and the join alone (no `ok`) fences every guarded table like the scalar form.
import { describe, expect, it } from 'vitest';
import { db } from './authority-ext-fixtures.ts';
import { authorityPredicate, tenantFilter } from './authority-read.ts';
import { actors, seed } from './authority-read-join-fixtures.ts';
import { assertActorOnce } from './authority-read-once.ts';
import { GUARDED_TABLES } from './authority-tables.ts';
import { all } from './db.ts';

describe('assertActorOnce evasions', () => {
  const cases: [string, (rows: string) => string][] = [
    ['upper case comma join', (r) => `FROM ${r}passes x, ACTOR_OK a2`],
    ['double-quoted', (r) => `FROM ${r}passes x WHERE x.org_id = (SELECT org_id FROM "actor_ok")`],
    ['single-quoted', (r) => `FROM ${r}passes x WHERE x.org_id = (SELECT org_id FROM 'actor_ok')`],
    ['bracketed', (r) => `FROM ${r}passes x WHERE x.org_id = (SELECT org_id FROM [actor_ok])`],
    ['backticked', (r) => `FROM ${r}passes x WHERE x.org_id = (SELECT org_id FROM \`actor_ok\`)`],
    [
      'quote inside a comment',
      (r) => `FROM ${r}passes x WHERE /* ' */ x.org_id = (SELECT org_id FROM actor_ok) /* ' */`,
    ],
    ['actor', (r) => `FROM ${r}passes x WHERE EXISTS (SELECT 1 FROM ACTOR)`],
    ['IN actor_ok', (r) => `FROM ${r}passes x WHERE x.org_id IN ACTOR_OK`],
    ['shadowed alias', (r) => `FROM ${r}passes x WHERE x.id IN (SELECT id FROM api_keys ao)`],
    ['ISNULL()', (r) => `FROM ${r}passes x WHERE ISNULL(ao.org_id)`],
    ['ISNULL postfix', (r) => `FROM ${r}passes x WHERE ao.org_id ISNULL`],
    ['parenthesised', (r) => `FROM ${r}passes x WHERE (ao.org_id) IS NULL`],
    ['COALESCE', (r) => `FROM ${r}passes x WHERE COALESCE(ao.org_id, '') = ''`],
    ['IS NOT NOT NULL', (r) => `FROM ${r}passes x WHERE ao.org_id IS NOT NOT NULL`],
    ['bare platform term', (r) => `FROM ${r}passes x WHERE ao.org_id IS NULL`],
  ];
  it.each(cases)('refuses %s', async (_n, from) => {
    const s = await seed();
    const p = authorityPredicate(s.w.x.member(), { scope: 'org_mode', now: s.f.clock.now() });
    expect(() => assertActorOnce(`WITH ${p.ctes} SELECT 1 ${from(p.rows)}`)).toThrow(
      /SQL_ACTOR_REUSE|joins actor_ok once/,
    );
  });

  it('allows the platform term, comments and a nested single reference', async () => {
    const s = await seed();
    const p = authorityPredicate(s.w.x.member(), { scope: 'org_mode', now: s.f.clock.now() });
    const ok = (tail: string) => assertActorOnce(`WITH ${p.ctes} SELECT 1 FROM ${p.rows}${tail}`);
    expect(() => ok(`passes x WHERE ${p.platform}`)).not.toThrow();
    expect(() => ok(`passes x WHERE ${p.ok} AND ao.org_id IS NULL`)).not.toThrow();
    expect(() => ok(`passes x /* actor_ok ' */ -- actor_ok\n WHERE x.id = ?`)).not.toThrow();
    expect(() => ok(`passes x WHERE x.id = 'ACTOR_OK ''x'`)).not.toThrow();
  });
});

describe('platform anchor', () => {
  it('a missing key returns no foreign rows with the platform term, and the bare term is refused', async () => {
    const s = await seed();
    const p = authorityPredicate(
      { kind: 'api_key', keyId: 'no-such-key', scope: 'scans:read' },
      { scope: 'platform', now: s.f.clock.now() },
    );
    const q = (where: string) =>
      `WITH ${p.ctes} SELECT x.id FROM ${p.anchor} CROSS JOIN passes x WHERE ${where}`;
    expect(await all(db, q(p.platform), p.params)).toEqual([]);
    expect((await all(db, q('ao.org_id IS NULL'), p.params)).length).toBeGreaterThan(0);
    expect(() => assertActorOnce(q('ao.org_id IS NULL'))).toThrow(/SQL_ACTOR_REUSE|once/);
    expect(() => assertActorOnce(q(p.platform))).not.toThrow();
  });

  it('tenant always opens with the org equality', () => {
    const p = authorityPredicate(
      { kind: 'api_key', keyId: 'k', scope: 'passes:read' },
      { scope: 'org_mode', now: 1 },
    );
    for (const [table, t] of Object.entries(GUARDED_TABLES))
      if (t.org !== null) expect(p.tenant('x', table)).toMatch(/^x\.\w+ = ao\.org_id|^x\.scope = /);
  });
});

describe('the join alone fences', () => {
  it('rows, anchor WHERE and anchor ON equal the scalar form on every guarded table, without ok', async () => {
    const s = await seed();
    const now = s.f.clock.now();
    const norm = (rows: Record<string, unknown>[]) =>
      rows
        .filter((r) => Object.values(r).some((v) => v !== null))
        .map((r) => JSON.stringify(r))
        .sort();
    let nonEmpty = 0;
    for (const actor of await actors(s)) {
      if (actor.scope === 'platform' || actor.check) continue;
      const p = authorityPredicate(actor.principal, { scope: actor.scope, now });
      for (const [table, t] of Object.entries(GUARDED_TABLES)) {
        if (t.org === null) continue;
        for (const scope of ['org', 'org_mode'] as const) {
          const old = norm(
            await all(
              db,
              `WITH ${p.ctes} SELECT x.* FROM ${table} x WHERE EXISTS (SELECT 1 FROM actor_ok) AND ${tenantFilter('x', table, scope)}`,
              p.params,
            ),
          );
          const tn = p.tenant('x', table, scope);
          const forms = {
            rows: `FROM ${p.rows}${table} x WHERE ${tn}`,
            where: `FROM ${p.anchor} CROSS JOIN ${table} x WHERE ${tn}`,
            on: `FROM ${p.anchor} LEFT JOIN ${table} x ON ${tn}`,
          };
          for (const [form, from] of Object.entries(forms)) {
            const sql = `WITH ${p.ctes} SELECT x.* ${from}`;
            assertActorOnce(sql);
            expect(
              norm(await all(db, sql, p.params)),
              `${actor.name} ${table} ${scope} ${form}`,
            ).toEqual(old);
          }
          if (old.length > 0) nonEmpty++;
        }
      }
    }
    expect(nonEmpty).toBeGreaterThan(40);
  });
});
