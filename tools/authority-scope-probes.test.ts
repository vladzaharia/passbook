// Reviewer probes for the fragment placement rule, kept as tables: SQL and whether it must pass or fail.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: SQL and source text matched as strings
import { describe, expect, it } from 'vitest';
import { fragmentFindings, rawWriteStatements, uninlinedWriteCalls } from './authority-scope.ts';
import { fragmentPlacement } from './authority-scope-placement.ts';

type Want = 'pass' | 'fail';
const src = (body: string) =>
  `import { run } from '../../platform/db.ts';\nexport async function f(db, frag, x, y, a, b, c) {\n${body}\n}\n`;
const R = (sql: string) => `await run(db, \`${sql}\`, []);`;

const SOURCE_CASES: [string, string, Want][] = [
  ['baseline ok', R('DELETE FROM passes WHERE id = ? AND (${frag.sql})'), 'pass'],
  ['baseline OR', R('DELETE FROM passes WHERE id = ? OR (${frag.sql})'), 'fail'],
  ['bare WHERE', R('DELETE FROM passes WHERE ${frag.sql}'), 'fail'],
  ['WHERE (x) alone', R('DELETE FROM passes WHERE (${frag.sql})'), 'pass'],
  ['OR NOT', R('DELETE FROM passes WHERE id = ? OR NOT (${frag.sql})'), 'fail'],
  [
    '-- comment hides OR',
    R('DELETE FROM passes WHERE org_id = ? OR -- AND\n (${frag.sql})'),
    'fail',
  ],
  [
    'string parens',
    R("DELETE FROM passes WHERE org_id = ? OR name = '(' OR (${frag.sql}) OR name = ')'"),
    'fail',
  ],
  [
    'string AND',
    R("DELETE FROM passes WHERE org_id = ? OR name = 'x AND' AND (${frag.sql})"),
    'pass',
  ],
  ['top group OR', R('DELETE FROM passes WHERE (org_id = ? OR (${frag.sql}))'), 'fail'],
  [
    'subquery OR',
    R(
      'DELETE FROM pass_assets WHERE pass_id IN (SELECT id FROM passes WHERE org_id = ? OR (${frag.sql}))',
    ),
    'fail',
  ],
  [
    'subquery AND',
    R(
      'DELETE FROM pass_assets WHERE pass_id IN (SELECT id FROM passes WHERE org_id = ? AND (${frag.sql}))',
    ),
    'pass',
  ],
  [
    'exists AND',
    R(
      'DELETE FROM pass_assets WHERE a = ? AND EXISTS (SELECT 1 FROM passes p WHERE (${frag.sql}))',
    ),
    'pass',
  ],
  [
    'exists OR-joined',
    R('DELETE FROM pass_assets WHERE a = ? OR EXISTS (SELECT 1 FROM passes p WHERE (${frag.sql}))'),
    'fail',
  ],
  [
    'inlined const OR',
    `const w = \`org_id = ? OR (\${frag.sql})\`;\n  ${R('DELETE FROM passes WHERE ${w}')}`,
    'fail',
  ],
  [
    'inlined const unwrapped',
    `const w = \`\${frag.sql}\`;\n  ${R('DELETE FROM passes WHERE id = ? AND ${w}')}`,
    'fail',
  ],
  [
    'inlined lead AND unwrapped',
    `const w = \`id = ? AND \${frag.sql}\`;\n  ${R('DELETE FROM passes WHERE ${w}')}`,
    'fail',
  ],
  [
    'inlined const ok',
    `const w = \`id = ? AND (\${frag.sql})\`;\n  ${R('DELETE FROM passes WHERE ${w}')}`,
    'pass',
  ],
  ['two adjacent', R('DELETE FROM passes WHERE id = ? AND (${a} ${b})'), 'fail'],
  ['ternary OR', R("DELETE FROM passes WHERE id = ?${c ? ` OR (${frag.sql})` : ''}"), 'fail'],
  ['ternary AND', R("DELETE FROM passes WHERE id = ?${c ? ` AND (${frag.sql})` : ''}"), 'pass'],
  [
    'ternary nonliteral',
    R('DELETE FROM passes WHERE id = ? ${c ? `OR (${frag.sql})` : b}'),
    'fail',
  ],
  [
    'CASE top OR',
    R('DELETE FROM passes WHERE id = ? OR CASE WHEN (${frag.sql}) THEN 1 ELSE 0 END'),
    'fail',
  ],
  [
    'ORDER BY sub',
    R(
      'DELETE FROM passes WHERE id IN (SELECT id FROM passes WHERE org_id = ? ORDER BY (${frag.sql}) LIMIT 1)',
    ),
    'fail',
  ],
  [
    'LIMIT sub',
    R(
      'DELETE FROM passes WHERE id IN (SELECT id FROM passes WHERE org_id = ? LIMIT (${frag.sql}))',
    ),
    'fail',
  ],
  ['SET value', R('UPDATE passes SET x = (${frag.sql}) WHERE id = ?'), 'pass'],
  [
    'SET after sub WHERE',
    R('UPDATE passes SET a = (SELECT 1 FROM passes WHERE k = ?), b = (${frag.sql}) WHERE id = ?'),
    'pass',
  ],
  [
    'concat OR',
    "await run(db, 'DELETE FROM passes WHERE id = ? OR (' + frag.sql + ')', []);",
    'fail',
  ],
  ['AND NOT', R('DELETE FROM passes WHERE id = ? AND NOT (${frag.sql})'), 'pass'],
  [
    'ON CONFLICT OR',
    R(
      'INSERT INTO passes (id) VALUES (?) ON CONFLICT(id) DO UPDATE SET x = 1 WHERE passes.org_id = ? OR (${frag.sql})',
    ),
    'fail',
  ],
  [
    'UNION',
    R(
      'DELETE FROM passes WHERE id IN (SELECT id FROM passes WHERE org_id = ? UNION SELECT id FROM passes WHERE 1 OR (${frag.sql}))',
    ),
    'fail',
  ],
  ['trailing OR top', R('DELETE FROM passes WHERE (${frag.sql}) OR id = ?'), 'fail'],
  [
    'trailing OR in group',
    R('DELETE FROM passes WHERE org_id = ? AND ((${frag.sql}) OR state = ?)'),
    'fail',
  ],
  [
    'trailing OR after AND',
    R('DELETE FROM passes WHERE id = ? AND (${frag.sql}) OR state = ?'),
    'fail',
  ],
  [
    'NOT EXISTS ok',
    R('DELETE FROM passes WHERE id = ? AND NOT EXISTS (SELECT 1 FROM passes WHERE (${frag.sql}))'),
    'pass',
  ],
  ['semicolon in string', R("DELETE FROM passes WHERE note <> ';' OR (${frag.sql})"), 'fail'],
  [
    'IN list OR',
    R('DELETE FROM passes WHERE org_id = ? OR id IN (SELECT id FROM passes WHERE (${frag.sql}))'),
    'fail',
  ],
  [
    'concat || in group',
    R("DELETE FROM passes WHERE org_id = ? AND (a || 'z' = ? AND (${frag.sql}))"),
    'pass',
  ],
  [
    'double-quoted ident with (',
    R('DELETE FROM passes WHERE org_id = ? OR "(" = 1 OR (${frag.sql}) OR ")" = 1'),
    'fail',
  ],
  [
    'then ORDER BY',
    R(
      'DELETE FROM passes WHERE id IN (SELECT id FROM passes WHERE org_id = ? AND (${x.sql}) ORDER BY id LIMIT 5)',
    ),
    'pass',
  ],
  ['then RETURNING', R('DELETE FROM passes WHERE id = ? AND (${x.sql}) RETURNING id'), 'pass'],
  ['then AND', R('DELETE FROM passes WHERE id = ? AND (${x.sql}) AND b = ?'), 'pass'],
  [
    'then ternary AND',
    R("DELETE FROM passes WHERE id = ? AND (${x.sql})${c ? ' AND b = ?' : ''}"),
    'pass',
  ],
  [
    'then ternary OR',
    R("DELETE FROM passes WHERE id = ? AND (${x.sql})${c ? ' OR 1 = 1' : ''}"),
    'fail',
  ],
  [
    'then ternary else OR',
    R("DELETE FROM passes WHERE id = ? AND (${x.sql})${c ? '' : ' OR 1 = 1'}"),
    'fail',
  ],
  ['lowercase or', R('delete from passes where id = ? and (${x.sql}) or 1'), 'fail'],
  ['no space OR', R('DELETE FROM passes WHERE id = ? AND (${x.sql})OR 1'), 'fail'],
  ['comment then OR', R('DELETE FROM passes WHERE id = ? AND (${x.sql}) -- AND\n OR 1'), 'fail'],
  [
    'block comment then OR',
    R('DELETE FROM passes WHERE id = ? AND (${x.sql}) /* AND */ OR 1'),
    'fail',
  ],
  ['compare then OR', R('DELETE FROM passes WHERE (${x.sql}) = 0 OR id = ?'), 'fail'],
  ['IS NOT then OR', R('DELETE FROM passes WHERE (${x.sql}) IS NOT 0 OR id = ?'), 'fail'],
  [
    'inline const then OR',
    `const w = \`(\${x.sql}) OR 1\`;\n  ${R('DELETE FROM passes WHERE id = ? AND ${w}')}`,
    'fail',
  ],
  [
    'inline const tail ok',
    `const w = \`(\${x.sql})\`;\n  ${R('DELETE FROM passes WHERE id = ? AND ${w} AND b = ?')}`,
    'pass',
  ],
  [
    'nested group close',
    R('DELETE FROM passes WHERE id = ? AND (a = ? AND (${x.sql})) AND b = ?'),
    'pass',
  ],
  [
    'outer group OR after',
    R('DELETE FROM passes WHERE id = ? AND (a = ? AND (${x.sql})) OR b = ?'),
    'fail',
  ],
  [
    'sub ON CONFLICT ok',
    R(
      'INSERT INTO passes (id) SELECT ? FROM passes p WHERE p.org_id = ? AND (${x.sql}) ON CONFLICT(id) DO NOTHING',
    ),
    'pass',
  ],
  [
    'upsert where OR after',
    R(
      'INSERT INTO passes (id) VALUES (?) ON CONFLICT(id) DO UPDATE SET a = 1 WHERE passes.org_id = ? AND (${x.sql}) OR 1',
    ),
    'fail',
  ],
  [
    'exists then OR',
    R(
      'DELETE FROM passes WHERE id = ? AND EXISTS (SELECT 1 FROM passes p WHERE (${x.sql})) OR b = ?',
    ),
    'fail',
  ],
  [
    'IN with list then',
    R(
      'DELETE FROM passes WHERE org_id = ? AND id IN (SELECT id FROM passes p WHERE (${x.sql})) AND b = ?',
    ),
    'pass',
  ],
  ['two frags AND', R('DELETE FROM passes WHERE id = ? AND (${x.sql}) AND (${y.sql})'), 'pass'],
  ['two frags OR', R('DELETE FROM passes WHERE id = ? AND (${x.sql}) OR (${y.sql})'), 'fail'],
  ['BETWEEN trick', R('DELETE FROM passes WHERE id = ? AND a BETWEEN 1 AND (${x.sql})'), 'fail'],
  ['string then OR', R("DELETE FROM passes WHERE id = ? AND (${x.sql}) OR name = 'AND'"), 'fail'],
  [
    'SET case ok',
    R("UPDATE passes SET r = CASE WHEN (${x.sql}) THEN 'a' ELSE 'b' END WHERE id = ?"),
    'pass',
  ],
  [
    'GROUP BY HAVING OR',
    R(
      'DELETE FROM passes WHERE id IN (SELECT id FROM passes p WHERE org_id = ? GROUP BY id HAVING 1 OR (${x.sql}))',
    ),
    'fail',
  ],
  ['lower-case or', R('DELETE FROM passes WHERE id = ? and (${x.sql}) or 1'), 'fail'],
  [
    'else-branch OR after',
    R("DELETE FROM passes WHERE id = ? AND (${x.sql}) ${c ? 'AND a = 1' : 'OR 1 = 1'}"),
    'fail',
  ],
  [
    'OR in a branch before',
    R("DELETE FROM passes WHERE id = ? ${c ? 'AND' : 'OR'} (${x.sql})"),
    'fail',
  ],
];

// Direct statements, with the inline-ternary sentinels \u0001 and \u0002 where they matter.
const PLACEMENT_CASES: [string, string, Want][] = [
  [
    'IN without a space',
    'DELETE FROM passes WHERE org_id = ? OR id IN(SELECT id FROM passes WHERE (${x}))',
    'fail',
  ],
  [
    'IN',
    'DELETE FROM passes WHERE org_id = ? OR id IN (SELECT id FROM passes WHERE (${x}))',
    'fail',
  ],
  [
    'NOT IN',
    'DELETE FROM passes WHERE org_id = ? OR id NOT IN (SELECT id FROM passes WHERE (${x}))',
    'fail',
  ],
  [
    'scalar compare, OR',
    'DELETE FROM passes WHERE org_id = ? OR 0 = (SELECT count(*) FROM passes WHERE (${x}))',
    'fail',
  ],
  [
    'scalar compare, AND',
    'DELETE FROM passes WHERE org_id = ? AND 0 = (SELECT count(*) FROM passes WHERE (${x}))',
    'pass',
  ],
  [
    'subquery, OR after',
    'DELETE FROM passes WHERE id IN (SELECT id FROM passes WHERE (${x}) OR org_id = ?)',
    'fail',
  ],
  ['AND then OR (${y})', 'DELETE FROM passes WHERE org_id = ? AND (${x}) OR (${y})', 'fail'],
  ['lower-case and/or', 'delete from passes where id = ? and (${x}) or 1', 'fail'],
  ['lower-case or', 'delete from passes where id = ? or (${x})', 'fail'],
  ['mixed-case where', 'DELETE FROM passes where id = ? OR (${x})', 'fail'],
  ['lower-case and, upper OR', 'DELETE FROM passes WHERE id = ? and (${x}) or 1', 'fail'],
  ['AND, lower-case or after', 'DELETE FROM passes WHERE id = ? AND (${x}) or 1', 'fail'],
  [
    'BETWEEN .. AND 2 AND',
    'DELETE FROM passes WHERE id = ? AND a BETWEEN 1 AND 2 AND (${x})',
    'pass',
  ],
  ['BETWEEN 1 AND (x)', 'DELETE FROM passes WHERE id = ? AND a BETWEEN 1 AND (${x})', 'fail'],
  [
    'ternary, AND branch then empty',
    'DELETE FROM passes WHERE id = ? AND (${x})\u0001 AND a = 1|\u0002 AND b = 2',
    'pass',
  ],
  [
    'ternary, both branches empty then OR',
    'DELETE FROM passes WHERE id = ? AND (${x})\u0001|\u0002 OR b = 2',
    'fail',
  ],
  [
    'nested ternary, OR in the last branch',
    'DELETE FROM passes WHERE id = ? AND (${x})\u0001\u0001|\u0002| OR 1\u0002',
    'fail',
  ],
  ['else-branch OR', 'DELETE FROM passes WHERE id = ? AND (${x})\u0001|OR 1 = 1\u0002', 'fail'],
];

const verdict = (found: string[], want: Want) =>
  want === 'pass' ? expect(found).toEqual([]) : expect(found.length).toBeGreaterThan(0);

describe('authority-scope placement probes', () => {
  it.each(SOURCE_CASES)('source: %s', (_name, body, want) => {
    verdict(fragmentFindings(src(body)), want);
  });

  it.each(PLACEMENT_CASES)('statement: %s', (_name, sql, want) => {
    verdict(fragmentPlacement(sql), want);
  });

  it('keeps a ; inside a quoted string in the statement', () => {
    const plain = src(R("DELETE FROM passes WHERE note <> ';' AND id = ?"));
    const widened = src(R("DELETE FROM passes WHERE note <> ';' OR (${frag.sql})"));
    expect(rawWriteStatements(plain)).toHaveLength(1);
    expect(rawWriteStatements(widened)).toHaveLength(1);
    expect(rawWriteStatements(widened)).not.toEqual(rawWriteStatements(plain));
    expect(uninlinedWriteCalls(widened)).toEqual(['passes:frag.sql']);
  });

  it('reads a lower-case write as a pinned statement', () => {
    expect(rawWriteStatements(src(R('delete from passes where id = ?')))).toHaveLength(1);
  });
});
