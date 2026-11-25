// biome-ignore-all lint/suspicious/noTemplateCurlyInString: SQL and source text matched as strings
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fragmentFindings, uninlinedWriteCalls } from './authority-scope.ts';
import { fragmentPlacement } from './authority-scope-placement.ts';
import { INLINE_CLOSE as C, INLINE_OPEN as O } from './authority-scope-statements.ts';

const root = new URL('..', import.meta.url).pathname;
const files = (() => {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.ts')) out.set(relative(root, path), readFileSync(path, 'utf8'));
    }
  };
  walk(join(root, 'src/worker'));
  return out;
})();
const findings = (rel: string, text = files.get(rel) ?? '') =>
  fragmentFindings(text, { rel, files });
const mutate = (rel: string, from: string, to: string) => {
  const text = files.get(rel) ?? '';
  expect(text, from).toContain(from);
  return findings(rel, text.replace(from, to));
};

const WRITE = 'DELETE FROM scans WHERE id = ?';
const placement = (tail: string) => fragmentPlacement(`${WRITE} ${tail}`);
const notAnded = [expect.stringContaining('not ANDed')];
const notParenthesized = [expect.stringContaining('not parenthesized')];

describe('authority-scope fragment placement', () => {
  it('accepts a fragment ANDed in as AND (${...})', () => {
    expect(placement('AND (${guard.sql})')).toEqual([]);
    expect(placement('AND NOT (${guard.sql})')).toEqual([]);
    expect(placement(`${O} AND (\${guard.sql})|${C}`)).toEqual([]);
    expect(placement(`AND ${O}(\${a.sql})|NOT (\${b.sql})${C}`)).toEqual([]);
    expect(placement('AND (id = ? AND (${guard.sql}))')).toEqual([]);
    expect(placement('AND EXISTS (SELECT 1 FROM t WHERE (${guard.sql}))')).toEqual([]);
    expect(placement('AND id IN (${placeholders(n)})')).toEqual([]);
    // A SET or CASE value and a select list are not conditions.
    expect(fragmentPlacement('UPDATE t SET x = (${count.sql}) WHERE id = ?')).toEqual([]);
    expect(
      fragmentPlacement("UPDATE t SET r = CASE WHEN ? OR (${f.sql}) THEN 'a' END WHERE id = ?"),
    ).toEqual([]);
    expect(fragmentPlacement('SELECT (${f.sql}) AS x FROM t WHERE id = ?')).toEqual([]);
  });

  it('fails an unparenthesized fragment', () => {
    expect(placement('AND ${guard.sql}')).toEqual(notParenthesized);
    expect(placement('AND (${a.sql} AND ${b.sql})')).toHaveLength(2);
    expect(placement('AND (x = ? OR ${guard.sql})')).toEqual(notParenthesized);
    expect(
      findings(
        'f.ts',
        'const w = `${frag.sql}`;\nrun(db, `DELETE FROM sessions WHERE id = ? AND ${w}`, []);',
      ),
    ).toEqual(notParenthesized);
  });

  it('fails an OR-joined fragment, bare or inside any group', () => {
    expect(placement('OR (${guard.sql})')).toEqual(notAnded);
    expect(placement('OR NOT (${guard.sql})')).toEqual(notAnded);
    expect(placement(`${O} OR (\${guard.sql})|${C}`)).toEqual(notAnded);
    expect(placement('AND (state = ? OR (${guard.sql}))')).toEqual(notAnded);
    expect(fragmentPlacement('DELETE FROM t WHERE (org_id = ? OR (${x}))')).toEqual(notAnded);
    expect(
      fragmentPlacement('DELETE FROM t WHERE id IN (SELECT id FROM u WHERE org_id = ? OR (${x}))'),
    ).toEqual(notAnded);
    expect(
      fragmentPlacement(
        'DELETE FROM t WHERE id IN (SELECT id FROM a WHERE (${x}) UNION SELECT id FROM b WHERE org_id = ? OR (${x}))',
      ),
    ).toEqual(notAnded);
    // The subquery is fine; the group that carries it is OR-joined.
    expect(placement('OR EXISTS (SELECT 1 FROM p WHERE (${guard.sql}))')).toEqual(notAnded);
  });

  it('fails a fragment OR-joined after it, at every level', () => {
    expect(fragmentPlacement('DELETE FROM t WHERE (${x}) OR id = ?')).toEqual(notAnded);
    expect(fragmentPlacement('DELETE FROM t WHERE id = ? AND ((${x}) OR s = ?)')).toEqual(notAnded);
    expect(
      fragmentPlacement('DELETE FROM t WHERE id IN (SELECT id FROM u WHERE (${x}) OR org_id = ?)'),
    ).toEqual(notAnded);
    expect(fragmentPlacement('DELETE FROM t WHERE (${x}) AND id = ? RETURNING id')).toEqual([]);
    expect(fragmentPlacement('DELETE FROM t WHERE id = ? AND (${x}) RETURNING id')).toEqual([]);
    expect(fragmentPlacement(`DELETE FROM t WHERE id = ? AND (\${x})${O} OR s = ?|${C}`)).toEqual(
      notAnded,
    );
  });

  it('checks every branch of a ternary after the fragment', () => {
    const run = (tail: string) =>
      findings(
        'f.ts',
        `run(db, \`DELETE FROM sessions WHERE id = ? AND (\${x.sql})${tail}\`, []);`,
      );
    expect(run(" ${c ? 'AND a = 1' : 'AND b = 1'}")).toEqual([]);
    expect(run(" ${c ? 'AND a = 1' : 'OR 1 = 1'}")).toEqual(notAnded);
    expect(run(" ${c ? 'OR 1 = 1' : 'AND a = 1'}")).toEqual(notAnded);
    expect(run("${c ? '' : ' OR 1 = 1'}")).toEqual(notAnded);
    expect(run("${c ? ' OR 1 = 1' : ''}")).toEqual(notAnded);
    expect(run("${c ? '' : ' AND a = 1'}")).toEqual([]);
    expect(run(" ${c ? '' : 'AND a = 1'} RETURNING id")).toEqual([]);
  });

  it('does not take the AND of a BETWEEN for a connective', () => {
    expect(fragmentPlacement('DELETE FROM t WHERE a = ? AND b BETWEEN 1 AND (${x})')).toEqual(
      notAnded,
    );
    expect(fragmentPlacement('DELETE FROM t WHERE a = ? AND b BETWEEN 1 AND 2 AND (${x})')).toEqual(
      [],
    );
  });

  it('walks back over IN, NOT IN and a comparison to the connective', () => {
    const w = (head: string) =>
      fragmentPlacement(`DELETE FROM t WHERE a = ? ${head} (SELECT id FROM u WHERE (\${x}))`);
    expect(w('OR id IN')).toEqual(notAnded);
    expect(w('OR id IN')).toEqual(notAnded);
    expect(w('OR id NOT IN')).toEqual(notAnded);
    expect(w('OR 0 =')).toEqual(notAnded);
    expect(w('AND id IN')).toEqual([]);
    expect(w('AND id NOT IN')).toEqual([]);
    expect(w('AND 0 =')).toEqual([]);
    expect(
      fragmentPlacement('DELETE FROM t WHERE a = ? OR id IN(SELECT id FROM u WHERE (${x}))'),
    ).toEqual(notAnded);
    expect(
      fragmentPlacement('DELETE FROM t WHERE a = ? OR 0 = (SELECT count(*) FROM u WHERE (${x}))'),
    ).toEqual(notAnded);
  });

  it('fails closed on a group it cannot place', () => {
    expect(
      fragmentPlacement('DELETE FROM t WHERE a = ? AND foo(SELECT 1 FROM u WHERE (${x}))'),
    ).toEqual(notAnded);
  });

  it('sees through an inlined constant', () => {
    const run = (w: string, where: string) =>
      findings(
        'f.ts',
        `const w = \`${w}\`;\nrun(db, \`DELETE FROM sessions WHERE id = ? ${where}\`, []);`,
      );
    expect(run('org_id = ? OR (${frag.sql})', 'AND ${w}')).toEqual(notAnded);
    expect(run('org_id = ? OR (${frag.sql})', 'AND (${w})')).toEqual(notAnded);
    expect(run('org_id = ? AND (${frag.sql})', 'AND (${w})')).toEqual([]);
  });

  it('ignores SQL comments and quoted strings when it reads the structure', () => {
    expect(placement('OR -- AND\n (${guard.sql})')).toEqual(notAnded);
    expect(placement('OR /* AND */ (${guard.sql})')).toEqual(notAnded);
    expect(placement("AND (note = '(' OR kind = ')') AND (${guard.sql})")).toEqual([]);
    expect(placement("AND note = ')' AND (${guard.sql})")).toEqual([]);
    expect(placement("OR note = ') AND' OR (${guard.sql})")).toEqual(notAnded);
  });

  it('fails the shipped statements once an OR is written in', () => {
    const sweep = 'src/worker/modules/retention/repo-sweep.ts';
    const received = 'AND (${e.sql}) AND EXISTS (SELECT 1 FROM retention_receipts';
    expect(findings(sweep)).toEqual([]);
    expect(
      mutate(sweep, received, 'OR (${e.sql}) AND EXISTS (SELECT 1 FROM retention_receipts'),
    ).toEqual(notAnded);
    expect(
      mutate(sweep, received, 'AND ${e.sql} AND EXISTS (SELECT 1 FROM retention_receipts'),
    ).toEqual(notParenthesized);
    const hook = 'src/worker/modules/webhooks/repo-retention.ts';
    expect(
      mutate(hook, received, 'OR (${e.sql}) AND EXISTS (SELECT 1 FROM retention_receipts'),
    ).toEqual(notAnded);
    const assets = 'src/worker/modules/passes/repo-history-assets.ts';
    expect(findings(assets)).toEqual([]);
    expect(
      mutate(
        assets,
        'AND EXISTS (SELECT 1 FROM passes p WHERE (${passWhere}))${',
        'OR EXISTS (SELECT 1 FROM passes p WHERE (${passWhere}))${',
      ),
    ).toEqual(notAnded);
  });
});

describe('authority-scope statement end', () => {
  it('does not end a statement at a ; inside a quoted SQL string or a comment', () => {
    const wrote = (where: string) =>
      uninlinedWriteCalls(`run(db, \`DELETE FROM sessions WHERE ${where}\`, []);`);
    expect(wrote("note = 'a;b' AND ${scopeSql(x)}")).toEqual(['sessions:scopeSql(x)']);
    expect(wrote('id = ? -- a;b\n AND ${scopeSql(x)}')).toEqual(['sessions:scopeSql(x)']);
    expect(wrote('id = ? /* ; */ AND ${scopeSql(x)}')).toEqual(['sessions:scopeSql(x)']);
    expect(wrote('id = ?; ${scopeSql(x)}')).toEqual([]);
  });
});
