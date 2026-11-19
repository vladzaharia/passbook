import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WARNING_CODES } from './warning-codes.ts';

const root = import.meta.dirname;
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(join(dir, e.name))
      : e.name.endsWith('.ts') && !e.name.includes('.test.')
        ? [join(dir, e.name)]
        : [],
  );

/** Warning codes written in the validators' source (warn('X'), 'warning', 'X', add('X', ..., 'warning')). */
function sourceCodes(): Set<string> {
  const found = new Set<string>();
  for (const file of files(root)) {
    const text = readFileSync(file, 'utf8');
    const prefix = relative(root, file).includes('scan-display') ? 'SCAN_DISPLAY_' : '';
    for (const m of text.matchAll(/\bwarn\(\s*['"`]([A-Z0-9_]+)['"`]/g)) found.add(prefix + m[1]);
    for (const m of text.matchAll(/'warning',\s*['"]([A-Z0-9_]+)['"]/g)) found.add(prefix + m[1]);
    for (const m of text.matchAll(/add\(\s*['"]([A-Z0-9_]+)['"][^;]*?'warning'\s*[,)]/g))
      found.add(prefix + m[1]);
  }
  return found;
}

describe('WARNING_CODES', () => {
  it('lists every warning the validators raise', () => {
    expect([...sourceCodes()].sort()).toEqual([...WARNING_CODES].sort());
  });
});
