import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { balanceSqlAnd } from './sql-balance.ts';

const db = (env as unknown as { DB: D1Database }).DB;
const terms = (n: number, term = (i: number) => `c${i}=${i}`) =>
  Array.from({ length: n }, (_, i) => term(i));
const padded = (sql: string) => `${sql}${' '.repeat(600)}`;
const withoutParens = (sql: string) => sql.replace(/[()]/g, '');

const TOO_DEEP = /Expression tree is too large/;

/** True when D1 compiles the statement, otherwise the error message. */
async function compiles(sql: string): Promise<true | string> {
  try {
    await db.prepare(`EXPLAIN ${sql}`).all();
    return true;
  } catch (error) {
    return String((error as Error).message);
  }
}

describe('balanceSqlAnd', () => {
  it('leaves short statements byte-identical', () => {
    const sql = 'SELECT 1 FROM t WHERE a=1 AND b=2';
    expect(balanceSqlAnd(sql)).toBe(sql);
  });

  it('leaves chains below the threshold byte-identical', () => {
    const sql = padded(`SELECT 1 FROM t WHERE ${terms(3).join(' AND ')}`);
    expect(balanceSqlAnd(sql)).toBe(sql);
  });

  it('only inserts parentheses', () => {
    const sql = padded(`SELECT 1 FROM t WHERE ${terms(40).join(' AND ')} ORDER BY a LIMIT 1`);
    const balanced = balanceSqlAnd(sql);
    expect(balanced).not.toBe(sql);
    expect(withoutParens(balanced)).toBe(withoutParens(sql));
  });

  it('keeps clauses after the chain outside the tree', () => {
    const balanced = balanceSqlAnd(
      padded(`SELECT 1 FROM t WHERE ${terms(16).join(' AND ')} ORDER BY a`),
    );
    expect(balanced).toMatch(/\) ORDER BY a/);
  });

  it('does not split the AND of BETWEEN', () => {
    const list = terms(16, (i) => `c${i} BETWEEN ${i} AND ${i + 1}`);
    const balanced = balanceSqlAnd(padded(`SELECT 1 FROM t WHERE ${list.join(' AND ')}`));
    for (const term of list) expect(balanced).toContain(term);
  });

  it('does not split inside CASE', () => {
    const term = 'CASE WHEN a=1 AND b=2 THEN 1 ELSE 0 END=1';
    const balanced = balanceSqlAnd(
      padded(`SELECT 1 FROM t WHERE ${terms(16, () => term).join(' AND ')}`),
    );
    expect(balanced.split(term).length).toBe(17);
  });

  it('balances chains inside CASE arms without crossing them', () => {
    const arm = terms(16).join(' AND ');
    const sql = padded(`SELECT 1 FROM t WHERE CASE WHEN x=1 THEN ${arm} ELSE ${arm} END`);
    const balanced = balanceSqlAnd(sql);
    expect(balanced).not.toBe(sql);
    expect(withoutParens(balanced)).toBe(withoutParens(sql));
    expect(balanced).toMatch(/THEN \(.*\) ELSE \(.*\) END/s);
  });

  it('compiles a long CASE arm under nested EXISTS', async () => {
    const arm = terms(120, () => '1=1').join(' AND ');
    const sql = padded(
      `SELECT 1 WHERE EXISTS (SELECT 1 WHERE EXISTS (SELECT 1 WHERE CASE WHEN 1 THEN ${arm} ELSE 0 END))`,
    );
    expect(await compiles(sql)).toMatch(TOO_DEEP);
    expect(await compiles(balanceSqlAnd(sql))).toBe(true);
  });

  it('keeps a deep trailing subquery at the root of the tree', () => {
    const deep = `EXISTS (SELECT 1 FROM t WHERE ${terms(8, (i) => `d${i}=1`).join(' AND ')})`;
    const balanced = balanceSqlAnd(
      padded(`SELECT 1 FROM t WHERE ${terms(6).join(' AND ')} AND ${deep}`),
    );
    expect(balanced).toMatch(/\) AND EXISTS \(SELECT 1 FROM t WHERE/);
    expect(balanced).not.toMatch(/\(EXISTS \(SELECT 1 FROM t WHERE/);
  });

  it('keeps a marker comment attached to its placeholder', () => {
    const list = terms(16, (i) => `c${i}=?/* scan-ephemeral-${i} */`);
    const balanced = balanceSqlAnd(padded(`SELECT 1 FROM t WHERE ${list.join(' AND ')}`));
    expect(balanced).not.toMatch(/\?\)+\/\*/);
    for (const term of list) expect(balanced).toContain(term);
  });

  it('ignores AND in strings and comments', () => {
    const term = "a=' AND b AND '/* AND */";
    const balanced = balanceSqlAnd(
      padded(`SELECT 1 FROM t WHERE ${terms(16, () => term).join(' AND ')}`),
    );
    expect(balanced.split("a=' AND b AND '").length).toBe(17);
    expect(balanced.split('/* AND */').length).toBe(17);
  });

  it('keeps OR looser than AND', () => {
    const left = terms(10, (i) => `a${i}=1`).join(' AND ');
    const right = terms(10, (i) => `b${i}=1`).join(' AND ');
    const balanced = balanceSqlAnd(padded(`SELECT 1 FROM t WHERE ${left} OR ${right}`));
    expect(balanced).toMatch(/\) OR \(/);
    expect(withoutParens(balanced)).toContain(`a9=1 OR b0=1`);
  });

  it('does not wrap select-list aliases', () => {
    const sql = padded(`SELECT ${terms(16).join(' AND ')} AS x FROM t`);
    expect(balanceSqlAnd(sql)).toBe(sql);
  });

  it('treats dotted keywords as columns', () => {
    const list = terms(16, (i) => `t.end=${i}`);
    const sql = padded(`SELECT 1 FROM t WHERE ${list.join(' AND ')}`);
    expect(balanceSqlAnd(sql)).not.toBe(sql);
  });

  it('returns malformed input unchanged', () => {
    for (const sql of [
      padded(`SELECT 1 WHERE (${terms(16).join(' AND ')}`),
      padded(`SELECT 1 WHERE ${terms(16).join(' AND ')})`),
      padded(`SELECT 1 WHERE ${terms(16).join(' AND ')} AND a='open`),
    ])
      expect(balanceSqlAnd(sql)).toBe(sql);
  });

  it('compiles chains that D1 otherwise rejects', async () => {
    const list = terms(300, () => '1=1').join(' AND ');
    const sql = padded(`SELECT 1 WHERE EXISTS (SELECT 1 WHERE EXISTS (SELECT 1 WHERE ${list}))`);
    expect(await compiles(sql)).toMatch(TOO_DEEP);
    expect(await compiles(balanceSqlAnd(sql))).toBe(true);
  });

  it('treats IS NOT DISTINCT FROM as an operator', async () => {
    const list = terms(12, (i) => `${i} IS NOT DISTINCT FROM ${i}`).join(' AND ');
    const sql = padded(`SELECT 1 AS ok WHERE ${list} AND 1 IS DISTINCT FROM 2`);
    const balanced = balanceSqlAnd(sql);
    expect(balanced).not.toBe(sql);
    expect(balanced).not.toMatch(/DISTINCT\)+ FROM|DISTINCT FROM \(/);
    expect((await db.prepare(balanced).all()).results).toEqual([{ ok: 1 }]);
  });

  it('keeps bound parameter order', async () => {
    const list = terms(40, (i) => `?=${i}`).join(' AND ');
    const sql = balanceSqlAnd(padded(`SELECT 1 AS ok WHERE ${list}`));
    const inOrder = Array.from({ length: 40 }, (_, i) => i);
    const swapped = [1, 0, ...inOrder.slice(2)];
    expect(
      (
        await db
          .prepare(sql)
          .bind(...inOrder)
          .all()
      ).results,
    ).toEqual([{ ok: 1 }]);
    expect(
      (
        await db
          .prepare(sql)
          .bind(...swapped)
          .all()
      ).results,
    ).toEqual([]);
  });

  it.each([
    ['all true', '1', [{ ok: 1 }]],
    ['one false', '0', []],
    ['one null', 'NULL', []],
  ])('matches the flat chain when %s', async (_name, odd, expected) => {
    const list = terms(40, (i) => (i === 23 ? odd : '1')).join(' AND ');
    const flat = padded(`SELECT 1 AS ok WHERE ${list}`);
    const balanced = balanceSqlAnd(flat);
    expect(balanced).not.toBe(flat);
    expect((await db.prepare(flat).all()).results).toEqual(expected);
    expect((await db.prepare(balanced).all()).results).toEqual(expected);
  });
});

describe('deep subquery WHERE', () => {
  const nest = (levels: number, inner: string, tail = '') => {
    let sql = inner;
    for (let i = 0; i < levels; i++)
      sql = `EXISTS (SELECT 1 FROM (SELECT 1 AS v) t${i} WHERE t${i}.v=1 AND ${terms(6, () => '1=1').join(' AND ')} AND ${sql}${tail})`;
    return padded(`SELECT 1 AS ok WHERE ${sql}`);
  };

  it('moves a deep WHERE into an inner-join ON clause', () => {
    const balanced = balanceSqlAnd(nest(3, '1=1'));
    expect(balanced).toContain('JOIN (SELECT 1 LIMIT 1) ON (');
    expect(balanced).toMatch(/^SELECT 1 AS ok WHERE /);
  });

  it('compiles nesting that D1 otherwise rejects', async () => {
    const sql = nest(5, terms(40, () => '1=1').join(' AND '));
    expect(await compiles(sql)).toMatch(TOO_DEEP);
    expect(await compiles(balanceSqlAnd(sql))).toBe(true);
  });

  it.each([
    ['true', '1=1', [{ ok: 1 }]],
    ['false', '1=0', []],
    ['null', 'NULL', []],
  ])(
    'matches the original result when the innermost term is %s',
    async (_name, inner, expected) => {
      const sql = nest(3, inner);
      const rewritten = balanceSqlAnd(sql);
      expect(rewritten).not.toBe(sql);
      expect((await db.prepare(sql).all()).results).toEqual(expected);
      expect((await db.prepare(rewritten).all()).results).toEqual(expected);
    },
  );

  it('keeps a left-join anti-join and trailing ORDER BY and LIMIT', async () => {
    const deep = terms(10, () => '1=1').join(' AND ');
    const sql = padded(`SELECT 1 AS ok WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 AS id) a
      LEFT JOIN (SELECT 2 AS id) b ON b.id=a.id
      WHERE b.id IS NULL AND EXISTS (SELECT 1 WHERE ${deep} AND EXISTS (SELECT 1 WHERE ${deep}))
      ORDER BY a.id LIMIT 1)`);
    const rewritten = balanceSqlAnd(sql);
    expect(rewritten).toMatch(
      /JOIN \(SELECT 1 LIMIT 1\) ON \([\s\S]*\)\s+ORDER BY a\.id LIMIT 1\)/,
    );
    expect((await db.prepare(sql).all()).results).toEqual([]);
    expect((await db.prepare(rewritten).all()).results).toEqual([]);
  });

  it('gives a FROM-less subquery a one-row source', async () => {
    const deep = terms(12, () => '1=1').join(' AND ');
    const sql = padded(
      `SELECT 1 AS ok WHERE EXISTS (SELECT 1 WHERE ${deep} AND EXISTS (SELECT 1 WHERE ${deep}))`,
    );
    const rewritten = balanceSqlAnd(sql);
    expect(rewritten).toContain(
      'EXISTS (SELECT 1 FROM (SELECT 1 LIMIT 1) JOIN (SELECT 1 LIMIT 1) ON (',
    );
    expect((await db.prepare(rewritten).all()).results).toEqual([{ ok: 1 }]);
  });

  it('leaves a subquery with a bare star and a shallow subquery alone', () => {
    const deep = terms(12, () => '1=1').join(' AND ');
    const star = padded(
      `SELECT 1 WHERE (SELECT count(*) FROM (SELECT * FROM t WHERE ${deep} AND EXISTS (SELECT 1 WHERE ${deep}))) > 0`,
    );
    expect(balanceSqlAnd(star)).not.toContain('SELECT * FROM t JOIN');
    const shallow = padded('SELECT 1 WHERE EXISTS (SELECT 1 FROM t WHERE a=1 AND b=2)');
    expect(balanceSqlAnd(shallow)).toBe(shallow);
  });

  it('does not rewrite the outermost WHERE', () => {
    const sql = padded(`DELETE FROM t WHERE ${terms(20).join(' AND ')}`);
    expect(balanceSqlAnd(sql)).not.toContain('JOIN (SELECT 1)');
  });
});
