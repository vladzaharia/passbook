// Differential: the join-once read predicate (`rows`, `anchor`, `tenant`) returns exactly the rows of the scalar
// form (`EXISTS (SELECT 1 FROM actor_ok)` with `tenantFilter`), for every actor kind, over seeded child rows.
import { describe, expect, it } from 'vitest';
import { passRow } from './authority-checks.ts';
import { db } from './authority-ext-fixtures.ts';
import { authorityPredicate, tenantFilter } from './authority-read.ts';
import { type Actor, actors, seed, TABLES } from './authority-read-join-fixtures.ts';
import { assertActorOnce } from './authority-read-once.ts';
import { all } from './db.ts';

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
      const oldWhere = `(SELECT org_id FROM actor_ok) IS NULL AND ${named ? 'x.org_id = (SELECT org_id FROM named) AND ' : ''}x.mode = (SELECT mode FROM actor_ok)`;
      const newWhere = `ao.org_id IS NULL AND ${named ? 'x.org_id = nm.org_id AND ' : ''}x.mode = ao.mode`;
      return {
        old: `WITH ${withNamed(p.ctes)} SELECT ${sel} FROM ${table} x WHERE EXISTS (SELECT 1 FROM actor_ok) AND ${oldWhere} ${tail}`,
        new: `WITH ${withNamed(p.ctes)} SELECT ${sel} FROM ${p.rows}${named ? 'named nm CROSS JOIN ' : ''}${table} x WHERE ${p.ok} AND ${newWhere} ${tail}`,
        params,
      };
    }
    if (actor.scope === 'platform') return null;
    return {
      old: `WITH ${p.ctes} SELECT ${sel} FROM ${table} x WHERE EXISTS (SELECT 1 FROM actor_ok) AND ${tenantFilter('x', table, scope)} ${tail}`,
      new: `WITH ${p.ctes} SELECT ${sel} FROM ${p.rows}${table} x WHERE ${p.ok} AND ${p.tenant('x', table, scope)} ${tail}`,
      params: p.params,
    };
  };
  return { p, rowsOf, params };
}

describe('join-once read predicate equals the scalar form', () => {
  it('returns the same rows, counts and verdict for every actor kind', async () => {
    const s = await seed();
    const now = s.f.clock.now();
    const ids = { own: s.w.a.pass, other: s.tb.passes.live ?? '' };
    let nonEmpty = 0;
    for (const actor of await actors(s)) {
      const { p, rowsOf } = forms(actor, now, ids);
      const verdict = (
        await all<{ v: number }>(
          db,
          `WITH ${p.ctes} SELECT EXISTS (SELECT 1 FROM actor_ok) AS v`,
          p.params,
        )
      )[0]?.v;
      const anchored = await all<{ v: number }>(
        db,
        `WITH ${p.ctes} SELECT CASE WHEN ${p.ok} THEN 1 ELSE 0 END AS v FROM ${p.anchor}`,
        p.params,
      );
      expect(anchored, `${actor.name}: anchor`).toEqual([{ v: verdict }]);
      for (const t of TABLES) {
        const q = rowsOf(t);
        if (!q) continue;
        assertActorOnce(q.new);
        const was = await all(db, q.old, q.params);
        const now2 = await all(db, q.new, q.params);
        expect(now2, `${actor.name}: ${t.table}`).toEqual(was);
        if (was.length > 0) nonEmpty++;
        const counted = rowsOf(t, true);
        const n = await all(db, counted?.new ?? '', counted?.params ?? []);
        expect(n, `${actor.name}: ${t.table} count`).toEqual([{ n: was.length }]);
      }
    }
    expect(nonEmpty).toBeGreaterThan(40);
  });

  it('sees what each limit allows, not just what the old form saw', async () => {
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
    expect(() => assertActorOnce(`WITH ${p.ctes} SELECT 1 FROM ${p.rows}passes x`)).not.toThrow();
    expect(() => assertActorOnce(`WITH ${p.ctes} SELECT 1 FROM passes x`)).toThrow();
    expect(() =>
      assertActorOnce(`WITH ${p.ctes}, key_tpl AS (SELECT 1) SELECT 1 FROM ${p.rows}passes x`),
    ).toThrow();
    // A literal that spells the CTE name is not a reference.
    expect(() =>
      assertActorOnce(`WITH ${p.ctes} SELECT 'FROM actor_ok' FROM ${p.rows}passes x`),
    ).not.toThrow();
  });
});
