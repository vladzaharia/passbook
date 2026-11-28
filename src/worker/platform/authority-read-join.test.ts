// The join-once read predicate (`rows`, `anchor`, `tenant`) over seeded child rows, for every actor kind. Differential:
// it returns exactly the rows of the scalar form it replaced (`EXISTS (SELECT 1 FROM actor_ok)` with one
// `(SELECT ... FROM actor_ok)` per column), rebuilt here from the new text. The scalar form is over the workerd
// 1.20261110.1 nesting limit, so this comparison runs on workerds whose SQLite accepts it.
import { describe, expect, it } from 'vitest';
import { passRow } from './authority-checks.ts';
import { db } from './authority-ext-fixtures.ts';
import { authorityPredicate } from './authority-read.ts';
import { type Actor, actors, seed, TABLES } from './authority-read-join-fixtures.ts';
import { assertActorOnce } from './authority-read-once.ts';
import { all } from './db.ts';

/** The scalar spelling of a tenant term written against `ao`. */
const scalar = (sql: string) =>
  sql
    .replaceAll('ao.org_id', '(SELECT org_id FROM actor_ok)')
    .replaceAll('ao.mode', '(SELECT mode FROM actor_ok)')
    .replaceAll('ao.limit_key', '(SELECT limit_key FROM actor_ok)');

function forms(actor: Actor, now: number, ids: { own: string; other: string }) {
  const checks = actor.check ? passRow(actor.check === 'own' ? ids.own : ids.other) : undefined;
  const p = authorityPredicate(actor.principal, {
    scope: actor.scope,
    now,
    ...(checks ? { checks } : {}),
  });
  const named = actor.platform?.named;
  const withNamed = (ctes: string) =>
    named ? `${ctes},\n named AS MATERIALIZED (SELECT ? AS org_id)` : ctes;
  const params = named ? [...p.params, named] : p.params;
  const rowsOf = ({ table, key, scope }: (typeof TABLES)[number], counted = false) => {
    const sel = counted ? 'count(*) AS n' : `${key} AS k`;
    const tail = counted ? '' : ' ORDER BY k';
    if (actor.platform) {
      if (table !== 'passes' && table !== 'scan_events') return null;
      const newWhere = `${p.platform} AND ${named ? 'x.org_id = nm.org_id AND ' : ''}x.mode = ao.mode`;
      const oldWhere = `(SELECT org_id FROM actor_ok) IS NULL AND ${named ? 'x.org_id = (SELECT org_id FROM named) AND ' : ''}x.mode = (SELECT mode FROM actor_ok)`;
      return {
        old: `WITH ${withNamed(p.ctes)} SELECT ${sel} FROM ${table} x WHERE EXISTS (SELECT 1 FROM actor_ok) AND ${oldWhere} ${tail}`,
        new: `WITH ${withNamed(p.ctes)} SELECT ${sel} FROM ${p.rows}${named ? 'named nm CROSS JOIN ' : ''}${table} x WHERE ${newWhere} ${tail}`,
        params,
      };
    }
    if (actor.scope === 'platform') return null;
    return {
      old: `WITH ${p.ctes} SELECT ${sel} FROM ${table} x WHERE EXISTS (SELECT 1 FROM actor_ok) AND ${scalar(p.tenant('x', table, scope))} ${tail}`,
      new: `WITH ${p.ctes} SELECT ${sel} FROM ${p.rows}${table} x WHERE ${p.ok} AND ${p.tenant('x', table, scope)} ${tail}`,
      params: p.params,
    };
  };
  return { p, rowsOf, params };
}

describe('join-once read predicate', () => {
  it('counts match rows, and the anchor verdict matches the row join, for every actor kind', async () => {
    const s = await seed();
    const now = s.f.clock.now();
    const ids = { own: s.w.a.pass, other: s.tb.passes.live ?? '' };
    let nonEmpty = 0;
    let compared = 0;
    let tooDeep = 0;
    for (const actor of await actors(s)) {
      const { p, rowsOf } = forms(actor, now, ids);
      const present = (
        await all<{ v: number }>(
          db,
          `WITH ${p.ctes} SELECT 1 AS v FROM ${p.rows}(SELECT 1) z`,
          p.params,
        )
      ).length;
      const anchored = await all<{ v: number }>(
        db,
        `WITH ${p.ctes} SELECT CASE WHEN ${p.ok} THEN 1 ELSE 0 END AS v FROM ${p.anchor}`,
        p.params,
      );
      expect(anchored, `${actor.name}: anchor`).toEqual([{ v: present }]);
      expect(
        await all(db, `WITH ${p.ctes} SELECT EXISTS (SELECT 1 FROM actor_ok) AS v`, p.params),
        `${actor.name}: verdict`,
      ).toEqual([{ v: present }]);
      for (const t of TABLES) {
        const q = rowsOf(t);
        if (!q) continue;
        assertActorOnce(q.new);
        const got = await all(db, q.new, q.params);
        const was = await all(db, q.old, q.params).catch((e: unknown) => {
          if (/nested too deep/.test(String(e))) return null;
          throw e;
        });
        if (was) compared++;
        else tooDeep++;
        if (was) expect(got, `${actor.name}: ${t.table} old vs new`).toEqual(was);
        if (got.length > 0) nonEmpty++;
        const counted = rowsOf(t, true);
        const n = await all(db, counted?.new ?? '', counted?.params ?? []);
        expect(n, `${actor.name}: ${t.table} count`).toEqual([{ n: got.length }]);
      }
    }
    expect(nonEmpty).toBeGreaterThan(40);
    // Where the old form is over the limit, the new form answers alone; it is never skipped silently.
    expect(compared + tooDeep).toBeGreaterThan(40);
    expect(compared > 0 || tooDeep > 0).toBe(true);
  });

  it('sees what each limit allows', async () => {
    const s = await seed();
    const now = s.f.clock.now();
    const ids = { own: s.w.a.pass, other: s.tb.passes.live ?? '' };
    const seen = async (name: string, table = 'passes') => {
      const actor = (await actors(s)).find((x) => x.name === name);
      if (!actor) throw new Error(name);
      const q = forms(actor, now, ids).rowsOf(
        TABLES.find((t) => t.table === table) as (typeof TABLES)[number],
      );
      return (await all<{ k: string }>(db, q?.new ?? '', q?.params ?? [])).map((r) => r.k);
    };
    const { w, tt } = s;
    expect(await seen('member live')).toEqual(
      [w.a.pass, w.b.pass, w.c.pass, w.x.s.pass.id]
        .sort()
        .concat([tt.passes.live ?? ''])
        .sort(),
    );
    expect(await seen('member test')).toEqual([tt.passes.test ?? '']);
    expect(await seen('one template')).toEqual([w.a.pass]);
    expect(await seen('two templates')).toEqual([w.a.pass, w.b.pass].sort());
    expect(await seen('style')).toEqual([w.a.pass]);
    expect(await seen('template and style')).toEqual([w.b.pass]);
    expect(await seen('another org key, named')).toEqual([]);
    expect(await seen('revoked')).toEqual([]);
    expect(await seen('scanner bad epoch')).toEqual([]);
    expect(await seen('member passRow of another org')).toEqual([]);
    expect(await seen('org key', 'webhook_endpoints')).toEqual([
      s.ident('wh-a'),
      s.ident('wh-ab'),
      s.ident('wh-all'),
    ]);
    expect(await seen('one template', 'webhook_endpoints')).toEqual([s.ident('wh-a')]);
  });

  it('a forgotten join fails to prepare, and a second actor join is refused', async () => {
    const s = await seed();
    const p = authorityPredicate(s.w.x.member(), { scope: 'org_mode', now: s.f.clock.now() });
    await expect(
      all(
        db,
        `WITH ${p.ctes} SELECT x.id FROM passes x WHERE ${p.tenant('x', 'passes')}`,
        p.params,
      ),
    ).rejects.toThrow(/no such column/);
    const twice = `WITH ${p.ctes} SELECT 1 FROM ${p.rows}passes x WHERE x.id IN (SELECT 1 FROM actor_ok)`;
    expect(() => assertActorOnce(twice)).toThrow(/joins actor_ok once/);
    expect(() =>
      assertActorOnce(`WITH ${p.ctes} SELECT 1 FROM ${p.rows}passes x WHERE ${p.ok}`),
    ).not.toThrow();
    expect(() => assertActorOnce(`WITH ${p.ctes} SELECT 1 FROM passes x`)).toThrow();
    expect(() =>
      assertActorOnce(`WITH ${p.ctes}, key_tpl AS (SELECT 1) SELECT 1 FROM ${p.rows}passes x`),
    ).toThrow();
    // A literal that spells the CTE name is not a reference.
    expect(() =>
      assertActorOnce(`WITH ${p.ctes} SELECT 'FROM actor_ok' FROM ${p.rows}passes x WHERE ${p.ok}`),
    ).not.toThrow();
  });
});
