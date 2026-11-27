// The guard (`assertActorOnce`) fails closed on every re-reference SQLite resolves to the CTE, the platform
// term needs `present`, and the join alone (no `ok`) fences every guarded table.
import { describe, expect, it } from 'vitest';
import { db } from './authority-ext-fixtures.ts';
import { authorityPredicate } from './authority-read.ts';
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
    [
      'IFNULL around a comparison',
      (r) => `FROM ${r}passes x WHERE IFNULL(ao.org_id = x.org_id, 1)`,
    ],
    [
      'IFNULL around a comparison after present',
      (r) =>
        `FROM ${r}passes x WHERE ao.authority_present_k7 = 1 AND IFNULL(x.org_id = ao.org_id, 1)`,
    ],
    ['IS NOT NOT NULL', (r) => `FROM ${r}passes x WHERE ao.org_id IS NOT NOT NULL`],
    [
      'ISNULL() after present',
      (r) => `FROM ${r}passes x WHERE ao.authority_present_k7 = 1 AND ISNULL(ao.org_id)`,
    ],
    [
      'ISNULL postfix after present',
      (r) => `FROM ${r}passes x WHERE ao.authority_present_k7 = 1 AND ao.org_id ISNULL`,
    ],
    [
      'parenthesised after present',
      (r) => `FROM ${r}passes x WHERE ao.authority_present_k7 = 1 AND (ao.org_id) IS NULL`,
    ],
    [
      'COALESCE after present',
      (r) => `FROM ${r}passes x WHERE ao.authority_present_k7 = 1 AND COALESCE(ao.org_id, '') = ''`,
    ],
    [
      'IS NOT NOT NULL after present',
      (r) => `FROM ${r}passes x WHERE ao.authority_present_k7 = 1 AND ao.org_id IS NOT NOT NULL`,
    ],
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
    expect(() => ok(`passes x WHERE ${p.ok} AND ${p.tenant('x', 'passes')}`)).not.toThrow();
    expect(() => ok(`passes x /* actor_ok ' */ -- actor_ok\n WHERE x.id = ?`)).not.toThrow();
    expect(() => ok(`passes x WHERE x.id = 'ACTOR_OK ''x'`)).not.toThrow();
  });
});

describe('platform anchor', () => {
  it('a missing key returns no foreign rows: the sentinel is not NULL', async () => {
    const s = await seed();
    const p = authorityPredicate(
      { kind: 'api_key', keyId: 'no-such-key', scope: 'scans:read' },
      { scope: 'platform', now: s.f.clock.now() },
    );
    const q = (where: string) =>
      `WITH ${p.ctes} SELECT x.id FROM ${p.anchor} CROSS JOIN passes x WHERE ${where}`;
    expect(await all(db, q(p.platform), p.params)).toEqual([]);
    expect(await all(db, q('ao.org_id IS NULL'), p.params)).toEqual([]);
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
  it('rows, anchor WHERE and anchor ON read the same rows on every guarded table, without ok', async () => {
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
      // The actor's own org, read from its CTE: independent of the tenant term under test.
      const [own] = await all<{ org_id: string | null }>(
        db,
        `WITH ${p.ctes} SELECT org_id FROM actor_ok`,
        p.params,
      );
      for (const [table, t] of Object.entries(GUARDED_TABLES)) {
        if (t.org === null) continue;
        for (const scope of ['org', 'org_mode'] as const) {
          const tn = p.tenant('x', table, scope);
          const forms = {
            rows: `FROM ${p.rows}${table} x WHERE ${tn}`,
            where: `FROM ${p.anchor} CROSS JOIN ${table} x WHERE ${tn}`,
            on: `FROM ${p.anchor} LEFT JOIN ${table} x ON ${tn}`,
          };
          const read = async (from: string) => {
            const sql = `WITH ${p.ctes} SELECT x.* ${from}`;
            assertActorOnce(sql);
            return norm(await all(db, sql, p.params));
          };
          const base = await read(forms.rows);
          for (const [form, from] of Object.entries(forms))
            expect(await read(from), `${actor.name} ${table} ${scope} ${form}`).toEqual(base);
          const col = t.org === 'scope' ? 'scope' : t.org;
          const mine = t.org === 'scope' ? `org:${own?.org_id}` : own?.org_id;
          // Oracle: no row of another org, and never more rows than the org owns.
          const owned = await all<{ n: number }>(
            db,
            `SELECT count(*) AS n FROM ${table} WHERE ${col} = ?`,
            [mine ?? ''],
          );
          expect(
            base.length,
            `${actor.name} ${table} ${scope} never exceeds own rows`,
          ).toBeLessThanOrEqual(owned[0]?.n ?? 0);
          const rowsRead = base.map((r) => JSON.parse(r) as Record<string, unknown>);
          for (const r of rowsRead)
            expect(r[col], `${actor.name} ${table} ${scope} foreign row`).toBe(mine);
          if (base.length > 0) nonEmpty++;
        }
      }
    }
    expect(nonEmpty).toBeGreaterThan(40);
  });
});
