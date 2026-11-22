// D1 refuses a statement whose expression tree is deeper than 100 ("Expression tree is too large"); the local
// workerd D1 enforces the same limit. A limited key's statements inline `key_templates` (0152, 0195: the view
// adds the parent's limits), and the view's depth adds to the statement's. Each table's condition is prepared
// here inside HEADROOM extra levels, so a view or reference that grows fails this test instead of a route.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { restrictRow, TEMPLATE_REFS } from './authority-restrict.ts';
import { all } from './db.ts';

/** Levels a real statement may put around the condition (grant wrappers, EXISTS, joins). */
const HEADROOM = 5;

const wrap = (condition: string, levels: number): string =>
  Array.from({ length: levels }).reduce<string>((inner) => `(1=1 AND ${inner})`, condition);

describe('limited-key conditions leave depth headroom on D1', () => {
  it.each(Object.keys(TEMPLATE_REFS))('%s', async (table) => {
    const condition = restrictRow(table, 't', 'g.limit_key').replace(/^ AND /, '');
    await expect(
      all(
        env.DB,
        `SELECT 1 FROM ${table} t JOIN (SELECT NULL AS limit_key) g WHERE ${wrap(condition, HEADROOM)} LIMIT 1`,
        [],
      ),
    ).resolves.toBeDefined();
  });

  it('fails when the headroom is gone (the probe measures something)', async () => {
    const deepest = Object.keys(TEMPLATE_REFS)
      .map((t) => restrictRow(t, 't', 'g.limit_key').replace(/^ AND /, ''))
      .sort((a, b) => b.length - a.length)[0] as string;
    await expect(all(env.DB, `SELECT 1 WHERE ${wrap(deepest, 100)}`, [])).rejects.toThrow(
      /too large|depth/i,
    );
  });
});
