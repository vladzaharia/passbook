// The absent-actor anchor row is a sentinel no stored value equals: seven wrappers that turn NULL into a match,
// over six expressions on every guarded table, return no row for an absent actor and the same rows as the rows form
// (which has no anchor row to wrap) for a present one. LIKE, GLOB and string-stripping functions are the documented
// exceptions; the guard refuses them (authority-read-shape.ts).
import { describe, expect, it } from 'vitest';
import { db } from './authority-ext-fixtures.ts';
import { authorityPredicate } from './authority-read.ts';
import { actors, seed } from './authority-read-join-fixtures.ts';
import { GUARDED_TABLES } from './authority-tables.ts';
import { all, run } from './db.ts';

/** Each turns a NULL operand into a match; the sentinel must make `E` false, so none selects a row. */
const WRAPPERS: [string, (e: string) => string][] = [
  ['CASE', (e) => `CASE WHEN (${e}) IS NULL THEN 1 ELSE (${e}) END = 1`],
  ['IFNULL', (e) => `IFNULL(${e}, 1) = 1`],
  ['COALESCE', (e) => `COALESCE(${e}, 1) = 1`],
  ['IS NULL', (e) => `(${e}) IS NULL`],
  ['+0 IS NULL', (e) => `(${e}) + 0 IS NULL`],
  ['IIF', (e) => `IIF((${e}) IS NULL, 1, ${e}) = 1`],
  ['NULLIF', (e) => `NULLIF(${e}, 1) IS NULL AND (${e}) IS NOT 1 AND (${e}) IS NULL`],
];

/** Stored texts the sentinel's decoded or stripped forms would equal (design section 4), as org ids and scopes. */
const SEEDS = ['�absent', 'absent', '\u0000', 'org:\u0000'];

async function seedAbsentLookalikes() {
  let n = 0;
  for (const id of SEEDS) {
    await run(
      db,
      "INSERT INTO orgs (id, slug, name, created_at, updated_at) VALUES (?, ?, 'x', 1, 1)",
      [id, `lookalike-${n++}`],
    );
    await run(db, "INSERT INTO settings (scope, key, value, updated_at) VALUES (?, 'k', '1', 1)", [
      `org:${id}`,
    ]);
  }
}

describe('the absent anchor row is a sentinel', () => {
  it('is never NULL for an absent actor and keeps the present actor values', async () => {
    const s = await seed();
    const absent = authorityPredicate(
      { kind: 'api_key', keyId: 'no-such-key', scope: 'passes:read' },
      { scope: 'org_mode', now: s.f.clock.now() },
    );
    const [row] = await all<Record<string, unknown>>(
      db,
      `WITH ${absent.ctes} SELECT ao.authority_present_k7 AS p, ao.org_id IS NULL AS o, ao.mode IS NULL AS m, ao.limit_key IS NULL AS k FROM ${absent.anchor}`,
      absent.params,
    );
    expect(row).toEqual({ p: 0, o: 0, m: 0, k: 0 });
    const platform = authorityPredicate(s.w.x.member(), {
      scope: 'org_mode',
      now: s.f.clock.now(),
    });
    const [own] = await all<Record<string, unknown>>(
      db,
      `WITH ${platform.ctes} SELECT ao.authority_present_k7 AS p, ao.org_id AS o FROM ${platform.anchor}`,
      platform.params,
    );
    expect(own?.p).toBe(1);
    expect(typeof own?.o).toBe('string');
  });

  it('seven NULL-absorbing wrappers over six expressions select nothing for an absent actor and the same rows for a present one', async () => {
    const s = await seed();
    await seedAbsentLookalikes();
    const now = s.f.clock.now();
    const all_ = await actors(s);
    const pick = (name: string) => all_.find((a) => a.name === name);
    const chosen = [
      'member live',
      'scanner good epoch',
      'platform key live, all orgs',
      'missing key',
      'scanner bad epoch',
      'member stale session',
    ].map((n) => pick(n));
    let absentRuns = 0;
    let presentRuns = 0;
    for (const actor of chosen) {
      if (!actor) throw new Error('actor missing from the fixtures');
      const p = authorityPredicate(actor.principal, { scope: actor.scope, now });
      const [live] = await all<{ n: number }>(
        db,
        `WITH ${p.ctes} SELECT count(*) AS n FROM actor_ok`,
        p.params,
      );
      const present = (live?.n ?? 0) === 1;
      for (const [table, t] of Object.entries(GUARDED_TABLES)) {
        if (t.org === null) continue;
        const orgCol = t.org === 'scope' ? 'scope' : t.org;
        const expressions = [
          p.tenant('x', table, 'org'),
          p.tenant('x', table, 'org_mode'),
          t.org === 'scope' ? `x.scope = 'org:' || ao.org_id` : `x.${orgCol} = ao.org_id`,
          'ao.limit_key IS NULL',
          `lower(x.${orgCol}) = ao.org_id`,
          `x.${orgCol} = 'org:' || ao.org_id`,
        ];
        for (const [wrapper, wrap] of WRAPPERS)
          for (const e of expressions) {
            // A stored NULL org (a platform key's row) would absorb the wrapper by itself; only the anchor side is under test.
            const where = `x.${orgCol} IS NOT NULL AND (${wrap(e)})`;
            const count = async (from: string) =>
              (
                await all<{ n: number }>(
                  db,
                  `WITH ${p.ctes} SELECT count(*) AS n FROM ${from} WHERE ${where}`,
                  p.params,
                )
              )[0]?.n;
            const viaAnchor = await count(`${p.anchor} CROSS JOIN ${table} x`);
            if (present) {
              expect(viaAnchor, `${actor.name} ${table} ${wrapper} ${e}`).toBe(
                await count(`${p.rows}${table} x`),
              );
              presentRuns++;
            } else {
              expect(viaAnchor, `${actor.name} ${table} ${wrapper} ${e}`).toBe(0);
              absentRuns++;
            }
          }
      }
    }
    expect(absentRuns).toBeGreaterThan(1000);
    expect(presentRuns).toBeGreaterThan(1000);
  });
});
