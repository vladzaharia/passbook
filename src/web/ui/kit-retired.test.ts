import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Retired modules: one row per module. A non-test file that imports a retired path fails, unless it
 * is in the row's `pending` set, which only shrinks: when an importer moves, delete it here (this
 * test fails on a stale entry). A package that retires something appends its row in the same PR.
 */
interface Retired {
  /** The module's path from src/web, as an import specifier ends. */
  path: string;
  replacement: string;
  /** src/web-relative importers still to move. */
  pending: readonly string[];
}

const RETIRED: readonly Retired[] = [
  {
    path: 'ui/empty-state',
    replacement: 'StateView (ui/state-view.tsx); the adapter goes in U-R1',
    pending: [
      'channel-previews/channel-previews.tsx',
      'channel-previews/wallet-channel.tsx',
      'scan/inside/inside-panel.tsx',
      'scan/roll-call/roll-call-panel.tsx',
      'ui/detail-error.tsx',
      'ui/index.ts',
      'ui/layout/error-pages.tsx',
      'ui/layout/org-chooser.tsx',
      'ui/layout/polaris-id-required.tsx',
      'ui/webhooks/delivery-list.tsx',
      'workbench/design/design-loaded.tsx',
      'workbench/design/design-page.tsx',
      'workbench/states/states.tsx',
      'workbench/tools/placeholder.tsx',
    ],
  },
  {
    path: 'ui/error-state',
    replacement: 'StateView (ui/state-view.tsx); the adapter goes in U-R1',
    pending: [
      'admin/test-inbox/preview.tsx',
      'routes/admin/all/route.tsx',
      'routes/admin/o/$orgId/route.tsx',
      'scan/ui/shift-sheet.tsx',
      'ui/detail-error.tsx',
      'ui/index.ts',
      'ui/layout/error-pages.tsx',
      'ui/layout/org-chooser.tsx',
      'ui/webhook-setup/listen-check.tsx',
      'ui/webhooks/delivery-inspector.tsx',
      'ui/webhooks/delivery-list.tsx',
      'workbench/design/anon/handoff-save.tsx',
      'workbench/keys/recent-calls.tsx',
      'workbench/states/states.tsx',
    ],
  },
  {
    path: 'ui/no-access-state',
    replacement: 'StateView (ui/state-view.tsx); the adapter goes in U-R1',
    pending: ['ui/index.ts', 'workbench/states/states.tsx'],
  },
];

const WEB = join(process.cwd(), 'src/web');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/.test(name) && !name.includes('.test.') && !name.endsWith('.gen.ts')
      ? [path]
      : [];
  });
const files = walk(WEB).map((path) => ({
  path: relative(WEB, path),
  text: readFileSync(path, 'utf8'),
}));

/** The module names this file imports or re-exports, as written. */
const specifiers = (text: string): string[] =>
  [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '');

const importers = (path: string): string[] =>
  files
    .filter(({ path: own, text }) =>
      specifiers(text).some(
        (s) =>
          /^[./@]/.test(s) &&
          s.replace(/\.tsx?$/, '').endsWith(`/${path.split('/').pop()}`) &&
          !own.endsWith(`${path}.tsx`),
      ),
    )
    .map((f) => f.path)
    .sort();

describe('retired modules', () => {
  for (const row of RETIRED) {
    it(`${row.path}: only the pending files import it; use ${row.replacement}`, () => {
      const found = importers(row.path);
      expect(
        found.filter((f) => !row.pending.includes(f)),
        `new importers of ${row.path}`,
      ).toEqual([]);
      expect(
        row.pending.filter((f) => !found.includes(f)),
        `moved: delete from pending`,
      ).toEqual([]);
    });
  }
});
