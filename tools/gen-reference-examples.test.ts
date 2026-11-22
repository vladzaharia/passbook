import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const refDir = resolve(root, 'docs/api/reference');
const digest = (): string =>
  createHash('sha256')
    .update(
      readdirSync(refDir)
        .sort()
        .map((f) => readFileSync(resolve(refDir, f)))
        .join('\n'),
    )
    .digest('hex');

describe('gen-reference-examples --check', () => {
  it('passes on the committed examples and writes nothing', () => {
    const before = digest();
    const run = spawnSync(
      process.execPath,
      [resolve(root, 'tools/gen-reference-examples.ts'), '--check'],
      { encoding: 'utf8', cwd: root },
    );
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(digest()).toBe(before);
  });
});
