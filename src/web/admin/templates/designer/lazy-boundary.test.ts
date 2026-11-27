import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');
const DESIGNER = join(SRC, 'web/admin/templates/designer');

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith('@/')
    ? join(SRC, spec.slice(2))
    : spec.startsWith('.')
      ? resolve(dirname(from), spec)
      : null;
  if (!base) return null;
  return (
    [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')].find(
      (c) => existsSync(c) && statSync(c).isFile(),
    ) ?? null
  );
}

/** Every module a static import reaches from the entries; `import type` and `import()` do not count. */
function reachable(entries: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  for (let file = queue.shift(); file; file = queue.shift()) {
    if (seen.has(file) || !/\.tsx?$/.test(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(
      /(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^'";]*?from\s+['"]([^'"]+)['"]/g,
    )) {
      const next = m[1] ? null : resolveImport(file, m[2] ?? '');
      if (next) queue.push(next);
    }
  }
  return seen;
}

const eager = reachable([
  join(DESIGNER, 'designer.tsx'),
  join(SRC, 'web/workbench/design/extras.tsx'),
]);
const has = (rel: string) => eager.has(join(SRC, rel));

describe('designer lazy boundaries', () => {
  it('reaches the core from its entries', () => {
    expect(has('web/admin/templates/designer/reducer.ts')).toBe(true);
    expect(has('web/admin/templates/designer/section-style.tsx')).toBe(true);
    expect(has('web/workbench/design/data-panel.tsx')).toBe(true);
  });

  it.each([
    'web/admin/templates/designer/scan/scan-mode.tsx',
    'web/admin/templates/designer/wallets/wallets-mode.tsx',
    'web/admin/templates/designer/paper-preview.tsx',
    'web/admin/templates/designer/paper-editor.tsx',
    'web/admin/templates/designer/section-stamps.tsx',
    'web/admin/templates/designer/section-inputs.tsx',
    'web/admin/templates/designer/section-fields.tsx',
    'web/admin/templates/designer/access/access-section.tsx',
    'web/admin/templates/designer/scan/actions/actions-section.tsx',
    'web/admin/templates/designer/issue-validators.ts',
    'web/admin/templates/designer/local-issues.ts',
    'web/admin/templates/designer/scan/document.ts',
    'web/admin/templates/designer/access/issues.ts',
    'passkit/stamps/compose.ts',
    'passkit/stamps/png.ts',
    'passkit/template/scan-actions.ts',
    'passkit/template/scan-display/validate.ts',
    'passkit/wallets/roles.ts',
    'web/workbench/design/code-panels.tsx',
    'web/workbench/design/sample-json.tsx',
    'web/workbench/playground/snippets.ts',
  ])('keeps %s out of the first load', (rel) => {
    expect(has(rel)).toBe(false);
  });
});
