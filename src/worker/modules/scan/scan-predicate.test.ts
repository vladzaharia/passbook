import { beforeAll, describe, expect, it } from 'vitest';
import { predicateStmt } from './scan-predicate.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
beforeAll(async () => {
  kit = await setupScanKit();
});

describe('predicateStmt', () => {
  it('answers 1 or 0 for a plain predicate', async () => {
    const db = kit.env.DB;
    expect(await predicateStmt(db, { sql: '? = 1', params: [1] }).first()).toEqual({
      authorized: 1,
    });
    expect(await predicateStmt(db, { sql: '? = 1', params: [2] }).first()).toEqual({
      authorized: 0,
    });
  });

  it('puts the CTEs of a staged predicate in front, binds in order', async () => {
    const staged = {
      sql: 'EXISTS (SELECT 1 FROM staged WHERE v = ?)',
      params: [7],
      ctes: 'staged AS MATERIALIZED (SELECT ? AS v)',
      cteParams: [7],
    };
    const db = kit.env.DB;
    expect(await predicateStmt(db, staged).first()).toEqual({ authorized: 1 });
    expect(await predicateStmt(db, { ...staged, params: [8] }).first()).toEqual({ authorized: 0 });
  });
});
