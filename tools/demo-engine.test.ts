import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DATASETS } from '../src/worker/connectors/demo/config.ts';
import connector from '../src/worker/connectors/demo/index.ts';
import { demoCtx } from '../src/worker/connectors/demo/test-kit.ts';

const SRC = resolve(import.meta.dirname, '../src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

describe('demo engine', () => {
  it('imports faker nowhere under src: it is a build-time tool only', () => {
    const offenders = walk(SRC)
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) => /(?:from|import\(|require\()\s*['"]@faker-js/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('keeps faker out of the Worker dependencies', () => {
    const pkg = JSON.parse(readFileSync(resolve(SRC, '../package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.['@faker-js/faker']).toBeUndefined();
    expect(pkg.devDependencies?.['@faker-js/faker']).toBe('10.6.0');
  });

  it.each(DATASETS)('%s: 1,000 records in under 100 ms', async (dataset) => {
    const ctx = demoCtx({ dataset, count: 1000, revision: 25 });
    // Warm the shared entities once; a sync pays this on its first page only.
    await connector.listChanges?.(ctx, null);
    const start = performance.now();
    let cursor: string | null = null;
    let n = 0;
    for (;;) {
      const page: Awaited<ReturnType<NonNullable<typeof connector.listChanges>>> | undefined =
        await connector.listChanges?.(ctx, cursor);
      if (!page) throw new Error('no listChanges');
      n += page.changes.length;
      cursor = page.cursor;
      if (!page.hasMore) break;
    }
    expect(n).toBe(1000);
    expect(performance.now() - start).toBeLessThan(100);
  });
});
