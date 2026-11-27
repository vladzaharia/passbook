// D1 refuses a statement whose expression tree is deeper than 100 ("Expression tree is too large"); the local
// workerd D1 enforces the same limit. A limited key's statements inline `key_templates` (0152, 0195: the view
// adds the parent's limits), and the view's depth adds to the statement's. Each table's condition is prepared
// here inside HEADROOM extra levels, so a view or reference that grows fails this test instead of a route.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { restrictRow, TEMPLATE_REFS } from './authority-restrict.ts';
import { all } from './db.ts';

/**
 * Levels a real statement may put around the condition (grant wrappers, EXISTS, joins), with margin. The deepest
 * condition measured fits 47 more levels, so this fails when a view or reference grows by about 20.
 */
const HEADROOM = 25;

const wrap = (condition: string, levels: number): string =>
  Array.from({ length: levels }).reduce<string>((inner) => `(1=1 AND ${inner})`, condition);

const fits = (table: string, levels: number) =>
  all(
    env.DB,
    `SELECT 1 FROM ${table} t JOIN (SELECT NULL AS limit_key) g WHERE ${wrap(
      restrictRow(table, 't', 'g.limit_key').replace(/^ AND /, ''),
      levels,
    )} LIMIT 1`,
    [],
  ).then(
    () => true,
    () => false,
  );

describe('limited-key conditions leave depth headroom on D1', () => {
  it.each(Object.keys(TEMPLATE_REFS))('%s', async (table) => {
    expect(await fits(table, HEADROOM)).toBe(true);
  });

  it('the probe measures something: the deepest table stops fitting before 100 levels', async () => {
    const deepest = 'webhook_deliveries';
    expect(await fits(deepest, 100)).toBe(false);
    let lo = HEADROOM;
    let hi = 100;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (await fits(deepest, mid)) lo = mid;
      else hi = mid;
    }
    expect(lo).toBeGreaterThan(HEADROOM);
    expect(lo).toBeLessThan(100);
  });
});
