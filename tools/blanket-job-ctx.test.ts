import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// `x.ctx = jobCtxOf(x)` brands every call of a test as a job and hides request-path bugs.
const BLANKET = /\b(\w+)\.ctx\s*=\s*(?:\{\s*\.\.\.\s*)?jobCtxOf\(/;

function* testFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* testFiles(path);
    else if (entry.name.endsWith('.test.ts')) yield path;
  }
}

describe('job context in tests', () => {
  it('is passed at system call sites, never assigned over a kit context', () => {
    const offenders = [...testFiles('src/worker')]
      .filter((f) => BLANKET.test(readFileSync(f, 'utf8')))
      .sort();
    expect(offenders).toEqual([]);
  });
});
