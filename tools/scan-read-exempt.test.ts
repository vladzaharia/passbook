import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = 'src/worker/modules/scan/';
const ALLOWED = new Set(['repo-read-authority.ts', 'repo-read-once-legacy-auth.ts']);

describe('scanRead exemption', () => {
  it('only the differential-test legacy reader skips the join-once check', () => {
    const users = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => readFileSync(dir + f, 'utf8').includes("'differential-legacy'"));
    expect(users.filter((f) => !ALLOWED.has(f))).toEqual([]);
    expect(users).toContain('repo-read-once-legacy-auth.ts');
  });
});
