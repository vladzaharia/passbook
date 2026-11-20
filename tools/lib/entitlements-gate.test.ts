import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runbookSql, singleSelect } from './baked-sync-wait.ts';
import { entitlementsRefusal, orgsWithoutEntitlements } from './entitlements-gate.ts';

describe('entitlements gate', () => {
  it('the runbook query is a single SELECT the deploy can run remotely', () => {
    const md = readFileSync(resolve(import.meta.dirname, '../../docs/operations.md'), 'utf8');
    expect(singleSelect(runbookSql(md, 'entitlements-gate') ?? '')).toMatch(
      /^SELECT o\.id FROM orgs o/,
    );
  });

  it('names the orgs and refuses while any is left', () => {
    const rows = orgsWithoutEntitlements(
      JSON.stringify([{ results: [{ id: 'o1' }, { id: 'o2' }] }]),
    );
    expect(entitlementsRefusal(rows)).toMatch(/2 org\(s\)[\s\S]*- o1\n- o2/);
    expect(entitlementsRefusal(orgsWithoutEntitlements('[{"results":[]}]'))).toBeNull();
  });

  it('unreadable output is an error, never an empty list', () => {
    expect(() => orgsWithoutEntitlements('{}')).toThrow(/cannot tell/);
    expect(() => orgsWithoutEntitlements('[{"results":[{"x":1}]}]')).toThrow(/cannot tell/);
  });
});
