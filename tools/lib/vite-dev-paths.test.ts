import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : /\.(ts|tsx)$/.test(e.name) && !e.name.includes('.test.')
        ? [join(dir, e.name)]
        : [],
  );
}

// `vite dev` routes every path to the Worker unless vite.config.ts lists it, so an import that
// reaches outside src/ 404s in dev while the build inlines it (the Quickstart chunk, sdk-status.json).
describe('vite dev paths', () => {
  it('lists each top-level folder outside src/ that src/web imports', () => {
    const config = readFileSync(join(root, 'vite.config.ts'), 'utf8');
    const folders = new Set<string>();
    for (const file of sources(join(root, 'src/web'))) {
      for (const m of readFileSync(file, 'utf8').matchAll(
        /from '((?:\.\.\/)+)(docs|marketing)\//g,
      )) {
        folders.add(m[2] ?? '');
      }
    }
    // src/shared files reach out too: sdk-status.json is imported from there.
    for (const file of sources(join(root, 'src/shared'))) {
      for (const m of readFileSync(file, 'utf8').matchAll(
        /from '(?:\.\.\/){2}(docs|marketing)\//g,
      )) {
        folders.add(m[1] ?? '');
      }
    }
    expect(folders.size).toBeGreaterThan(0);
    for (const f of folders) expect(config).toContain(`'!/${f}/*'`);
  });
});
