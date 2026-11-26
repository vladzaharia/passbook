import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

function* configs(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* configs(path);
    else if (/^wrangler\.jsonc?$/.test(name)) yield path;
  }
}

/** The Worker name and the D1 database names a wrangler config declares. */
function namesOf(path: string): string[] {
  const text = readFileSync(path, 'utf8');
  const worker = /^\s*"name":\s*"([^"]+)"/m.exec(text)?.[1];
  const databases = [...text.matchAll(/"database_name":\s*"([^"]+)"/g)].map((m) => m[1] as string);
  return [...(worker ? [worker] : []), ...databases];
}

describe('configs under test/', () => {
  it('never share a Worker or database name with a deployed config', () => {
    const deployed = new Set(
      [join(root, 'wrangler.jsonc'), ...configs(join(root, 'workers'))].flatMap(namesOf),
    );
    const found = [...configs(join(root, 'test'))];
    expect(found.length).toBeGreaterThan(0);
    for (const path of found)
      for (const name of namesOf(path))
        expect(
          deployed.has(name),
          `${relative(root, path)} names ${name}, which production uses`,
        ).toBe(false);
  });
});
