import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  activeMissingHeads,
  runbookSql,
  singleSelect,
  waitForBakedHeads,
} from './baked-sync-wait.ts';

describe('runbookSql', () => {
  it('reads a named block and strips list indentation', () => {
    const md = 'x\n   ```sql verify-heads\n   SELECT 1\n     FROM t\n   ```\n';
    expect(runbookSql(md, 'verify-heads')).toBe('SELECT 1\n  FROM t');
    expect(runbookSql(md, 'verify-other')).toBeNull();
  });

  it('the verify-heads query the deploy runs remotely is a single SELECT', () => {
    const md = readFileSync(resolve(import.meta.dirname, '../../docs/operations.md'), 'utf8');
    expect(singleSelect(runbookSql(md, 'verify-heads') ?? '')).toMatch(/^SELECT t\.id/);
  });
});

describe('singleSelect', () => {
  it('accepts one SELECT, with or without a trailing semicolon', () => {
    expect(singleSelect('  SELECT 1\n FROM t;\n')).toBe('SELECT 1\n FROM t');
  });

  it('refuses anything else', () => {
    for (const sql of [
      'DELETE FROM passes',
      'SELECT 1; DROP TABLE passes',
      'select 1;\nUPDATE passes SET status = 1',
      'WITH x AS (SELECT 1) DELETE FROM passes WHERE id IN (SELECT * FROM x)',
      '',
    ])
      expect(() => singleSelect(sql), sql).toThrow('single SELECT');
  });
});

describe('activeMissingHeads', () => {
  it('ignores archived templates', () => {
    const row = { id: 't', origin: 'baked', org_id: 'o', passes: 2 };
    const out = JSON.stringify([
      {
        results: [
          { ...row, status: 'active' },
          { ...row, id: 'a', status: 'archived' },
        ],
      },
    ]);
    expect(activeMissingHeads(out).map((r) => r.id)).toEqual(['t']);
    expect(activeMissingHeads(JSON.stringify([{ results: [] }]))).toEqual([]);
  });

  it('throws on output it cannot read instead of reporting nothing missing', () => {
    for (const out of [
      '[]',
      '{}',
      JSON.stringify({ error: { text: 'D1_ERROR' } }),
      JSON.stringify([{ success: false }]),
      JSON.stringify([{ results: [{ n: 1 }] }]),
    ])
      expect(() => activeMissingHeads(out), out).toThrow('Unexpected wrangler output');
    expect(() => activeMissingHeads('✘ [ERROR] Authentication error')).toThrow();
  });
});

describe('waitForBakedHeads', () => {
  const row = { id: 't', origin: 'baked', status: 'active', org_id: 'o', passes: 1 };
  it('triggers each round and stops when nothing is missing', async () => {
    let triggers = 0;
    const answers = [[row], [row], []];
    const left = await waitForBakedHeads({
      trigger: async () => void triggers++,
      missing: async () => answers.shift() ?? [],
      sleep: async () => {},
      intervalMs: 1,
      attempts: 5,
    });
    expect(left).toEqual([]);
    expect(triggers).toBe(3);
  });

  it('returns what is still missing after the last attempt', async () => {
    const left = await waitForBakedHeads({
      trigger: async () => {},
      missing: async () => [row],
      sleep: async () => {},
      intervalMs: 1,
      attempts: 2,
    });
    expect(left).toEqual([row]);
  });
});
