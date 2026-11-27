// Fixtures of the template-limit tests: one org with templates of its own, and keys limited in different ways.
import { makeApiKey, makePass, makeTemplate } from '../../../test/helpers/index.ts';
import { db } from './authority-ext-fixtures.ts';
import type { Principal } from './authority-principal.ts';
import { authorityPredicate } from './authority-read.ts';
import { assertActorOnce } from './authority-read-once.ts';
import { setupGrant } from './authority-test-fixtures.ts';
import { all, run } from './db.ts';

export type Setup = Awaited<ReturnType<typeof setupGrant>>;

/** One org with two templates of its own, a pass of each, and keys limited in different ways. */
export async function world(label: string) {
  const x = await setupGrant(label);
  const { f, org } = x.s;
  const template = async (id: string, styles: string[]) => {
    const t = makeTemplate({ id: `${label}-${id}`, orgId: org.id });
    const pass = await makePass(f, { orgId: org.id, template: t.resolved });
    await run(db, 'UPDATE templates SET styles = ? WHERE id = ?', [
      JSON.stringify(styles),
      t.resolved.id,
    ]);
    return { id: t.resolved.id, pass: pass.id };
  };
  const a = await template('a', ['coupon']);
  const b = await template('b', ['coupon', 'generic']);
  const c = await template('c', []);
  const key = async (options: { templateIds?: string[]; passStyles?: string[] }) =>
    (await makeApiKey(f, { orgId: org.id, scopes: ['passes:read', 'passes:write'], ...options }))
      .id;
  const principal = (keyId: string, scope = 'passes:write'): Principal => ({
    kind: 'api_key',
    keyId,
    scope,
  });
  return { x, org, a, b, c, key, principal };
}

/** The rows of `passes` a read by this principal sees, through the shared read predicate. */
export async function visible(x: Setup, principal: Principal, ids: string[]): Promise<string[]> {
  const p = authorityPredicate(principal, { scope: 'org_mode', now: x.s.f.clock.now() });
  const sql = `WITH ${p.ctes} SELECT p.id FROM ${p.rows}passes p WHERE ${p.ok} AND ${p.tenant('p', 'passes')} AND p.id IN (${ids.map(() => '?').join(',')}) ORDER BY p.id`;
  assertActorOnce(sql);
  const rows = await all<{ id: string }>(db, sql, [...p.params, ...ids]);
  return rows.map((r) => r.id).sort();
}
