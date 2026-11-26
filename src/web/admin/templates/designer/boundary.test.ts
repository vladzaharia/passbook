import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(process.cwd(), 'src/web/admin/templates/designer');
const WEB = join(process.cwd(), 'src/web');
const HOST_DIR = join(ROOT, 'admin');

/** Admin scope, the router and the session client: only the admin host may reach them. */
const ADMIN_ONLY = [
  'lib/api.ts',
  'lib/org-filter.tsx',
  'lib/scope.ts',
  'lib/mode.ts',
  'lib/session.ts',
];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$|fixtures/.test(entry.name) ? [path] : [];
  });
}

function imports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map((m) => m[1] ?? '');
}

/** An import as a path under src/web, or the bare package name. */
function target(file: string, spec: string): string {
  if (spec.startsWith('@/web/')) return spec.slice('@/web/'.length);
  if (spec.startsWith('.')) return relative(WEB, resolve(dirname(file), spec));
  return spec;
}

const core = sources(ROOT).filter((file) => !file.startsWith(`${HOST_DIR}/`));

describe('designer core boundary', () => {
  it('has a core to check', () => {
    expect(core.length).toBeGreaterThan(150);
  });

  it('reaches admin scope, the router and the session client only through the admin host', () => {
    const leaks = core.flatMap((file) =>
      imports(file)
        .map((spec) => target(file, spec))
        .filter((t) => t === '@tanstack/react-router' || ADMIN_ONLY.includes(t))
        .map((t) => `${relative(ROOT, file)} -> ${t}`),
    );
    expect(leaks).toEqual([]);
  });

  it('never imports the admin host', () => {
    const inward = core.flatMap((file) =>
      imports(file)
        .map((spec) => target(file, spec))
        .filter((t) => t.startsWith('admin/templates/designer/admin/'))
        .map((t) => `${relative(ROOT, file)} -> ${t}`),
    );
    expect(inward).toEqual([]);
  });
});
