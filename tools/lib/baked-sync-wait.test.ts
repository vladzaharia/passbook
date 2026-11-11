import { describe, expect, it } from 'vitest';
import { activeMissingHeads, runbookSql, waitForBakedHeads } from './baked-sync-wait.ts';

describe('runbookSql', () => {
  it('reads a named block and strips list indentation', () => {
    const md = 'x\n   ```sql verify-heads\n   SELECT 1\n     FROM t\n   ```\n';
    expect(runbookSql(md, 'verify-heads')).toBe('SELECT 1\n  FROM t');
    expect(runbookSql(md, 'verify-other')).toBeNull();
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
