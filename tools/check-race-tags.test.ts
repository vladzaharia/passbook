import { describe, expect, it } from 'vitest';
import { sqlTextMatchers } from './check-race-tags.ts';

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
