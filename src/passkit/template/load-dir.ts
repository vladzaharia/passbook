// Node only: reads a template package directory. Used by tests and tools, never by the Worker.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readTemplatePackage, type TemplatePackage } from './package.ts';

function walk(dir: string, base: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path, base) : [relative(base, path)];
    })
    .filter((name) => !name.endsWith('.DS_Store'));
}

export function readTemplateDir(dir: string): Promise<TemplatePackage> {
  const files: Record<string, Uint8Array> = {};
  for (const name of walk(dir, dir)) files[name] = new Uint8Array(readFileSync(join(dir, name)));
  return readTemplatePackage(files);
}

export function listTemplateDirs(root: string): string[] {
  return readdirSync(root)
    .filter((name) => !name.startsWith('_') && statSync(join(root, name)).isDirectory())
    .sort();
}
