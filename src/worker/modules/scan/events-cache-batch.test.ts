import { describe, expect, it } from 'vitest';
import { makeScanEvent } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import {
  call,
  clock,
  env,
  f,
  orgId,
  page,
  primaryTemplate,
  reader,
  templateId,
} from './events-tenant-split-test-fixtures.ts';
import { makeLegacyScanPass } from './test-kit.ts';

const CACHE_WRITE = /\bUPDATE\s+scan_events\b[\s\S]*\bSET\s+expected\s*=/i;

/** Counts the batches that hold a cache fill; `before` runs ahead of the first one. */
function watchCacheBatches(before?: () => Promise<unknown>) {
  const real = env.DB;
  const sqlOf = new WeakMap<object, string>();
  const unwrapped = new WeakMap<object, D1PreparedStatement>();
  const seen: number[] = [];
  let intervened = false;
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
            const wrapped: D1PreparedStatement = new Proxy(statement, {
              get(t, p) {
                if (p === 'bind') return (...values: unknown[]) => wrap(t.bind(...values));
                const value = Reflect.get(t, p, t);
                return typeof value === 'function' ? value.bind(t) : value;
              },
            });
            sqlOf.set(wrapped, sql);
            unwrapped.set(wrapped, statement);
            return wrapped;
          };
          return wrap(target.prepare(sql));
        };
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          const fills = statements.filter((s) => CACHE_WRITE.test(sqlOf.get(s) ?? '')).length;
          if (fills > 0) {
            seen.push(fills);
            if (before && !intervened) {
              intervened = true;
              await before();
            }
          }
          return target.batch(statements.map((s) => unwrapped.get(s) ?? s));
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(env, { DB: db });
  return { seen, restore: () => Object.assign(env, { DB: real }) };
}

const cachedIds = async () =>
  (
    await env.DB.prepare(
      'SELECT id FROM scan_events WHERE org_id = ? AND expected_at IS NOT NULL ORDER BY id',
    )
      .bind(orgId)
      .all<{ id: string }>()
  ).results.map((r) => r.id);

describe('event list cache fills', () => {
  it('commits the fills of a page as one grant', async () => {
    for (let i = 0; i < 3; i++) await makeScanEvent(f, { orgId, templateIds: [templateId] });
    await makeLegacyScanPass(f, { orgId, template: primaryTemplate.resolved });
    const watch = watchCacheBatches();
    try {
      const listed = await page(await call(reader, 'GET', `?orgId=${orgId}`));
      expect(listed.items).toHaveLength(4);
      expect(listed.items.every((item) => item.expected === 1)).toBe(true);
    } finally {
      watch.restore();
    }
    expect(watch.seen).toEqual([4]);
    expect(await cachedIds()).toHaveLength(4);
  });

  it('a raced event costs only its own fill', async () => {
    const ids = [
      ...(await Promise.all(
        [0, 1].map(async () => (await makeScanEvent(f, { orgId, templateIds: [templateId] })).id),
      )),
    ];
    const raced = ids[0] as string;
    const watch = watchCacheBatches(() =>
      run(env.DB, 'UPDATE scan_events SET expected = 99, expected_at = ? WHERE id = ?', [
        clock.now() - 1,
        raced,
      ]),
    );
    try {
      const listed = await page(await call(reader, 'GET', `?orgId=${orgId}`));
      expect(listed.items).toHaveLength(3);
    } finally {
      watch.restore();
    }
    // One grant for three fills (refused), then each alone: the raced one is skipped.
    expect(watch.seen).toEqual([3, 1, 1, 1]);
    const cached = await cachedIds();
    expect(cached).toHaveLength(3);
    const row = await env.DB.prepare('SELECT expected FROM scan_events WHERE id = ?')
      .bind(raced)
      .first<{ expected: number }>();
    expect(row?.expected).toBe(99);
  });
});
