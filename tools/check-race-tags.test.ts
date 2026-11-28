import { describe, expect, it } from 'vitest';
import { sqlTextMatchers, tagProblems } from './check-race-tags.ts';

const rel = 'src/worker/modules/scan/x.test.ts';
const file = (...lines: string[]) => ['const db = new Proxy(real, {});', ...lines].join('\n');

describe('sqlTextMatchers', () => {
  it('flags an interceptor that matches SQL text', () => {
    expect(
      sqlTextMatchers(rel, file('if (sql.includes("INSERT INTO scans")) fire();')),
    ).toHaveLength(1);
    expect(sqlTextMatchers(rel, file('if (/UPDATE scans/.test(sql)) fire();'))).toHaveLength(1);
    expect(sqlTextMatchers(rel, file('if (String(sql).includes("x")) fire();'))).toHaveLength(1);
  });

  it('reports file and line', () => {
    expect(sqlTextMatchers(rel, file('if (sql.includes("x")) fire();'))[0]).toMatch(
      /^src\/.*x\.test\.ts:2: /,
    );
  });

  it('accepts a tag match', () => {
    expect(sqlTextMatchers(rel, file('if (sql.includes(RACE_GATE_WRITE)) fire();'))).toEqual([]);
    expect(sqlTextMatchers(rel, file('if (sql.includes(tag)) fire();'))).toEqual([]);
  });

  it('exempts a line marked sql-shape and comment lines', () => {
    expect(sqlTextMatchers(rel, file('if (sql.includes("x")) shape(); // sql-shape'))).toEqual([]);
    expect(sqlTextMatchers(rel, file('// sql.includes("x") is not allowed'))).toEqual([]);
  });

  it('ignores a file with no interceptor machinery', () => {
    expect(sqlTextMatchers(rel, 'if (sql.includes("x")) fire();')).toEqual([]);
  });
});

describe('matcher edges', () => {
  it('accepts a tag after a space and flags SQL under another name', () => {
    expect(sqlTextMatchers(rel, file('if (sql.includes( RACE_GATE_WRITE)) fire();'))).toEqual([]);
    expect(sqlTextMatchers(rel, file('if (batchSql.includes("x")) fire();'))).toHaveLength(1);
    expect(sqlTextMatchers(rel, file('if (/x/i.test(statementText)) fire();'))).toHaveLength(1);
  });
});

describe('tagProblems', () => {
  const defs = 'src/worker/platform/race-tag.ts';
  const def = (...tags: string[]) => tags.map((t) => `export const ${t};`).join('\n');
  const used = { 'src/a.ts': 'RACE_A', 'src/a.test.ts': 'RACE_A' };

  it('accepts a tag used in production and in a test', () => {
    const files = { [defs]: def("RACE_A = '/* race:a */'"), ...used };
    expect(tagProblems(files, [defs])).toEqual([]);
  });

  it('flags a duplicate value', () => {
    const files = { [defs]: def("RACE_A = '/* race:a */'", "RACE_B = '/* race:a */'"), ...used };
    expect(tagProblems(files, [defs]).some((p) => p.includes('share the value'))).toBe(true);
  });

  it('flags a tag with no production use or no test use', () => {
    const d = def("RACE_A = '/* race:a */'");
    expect(tagProblems({ [defs]: d, 'src/a.test.ts': 'RACE_A' }, [defs])).toEqual([
      'RACE_A has no production use',
    ]);
    expect(tagProblems({ [defs]: d, 'src/a.ts': 'RACE_A' }, [defs])).toEqual([
      'RACE_A has no test use',
    ]);
  });
});
