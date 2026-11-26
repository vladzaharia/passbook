import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

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

describe('kit lint', () => {
  it('times motion with tokens, not raw durations or bare transition-colors', () => {
    for (const { path, text } of files) {
      expect(text, path).not.toMatch(/\bduration-[12]\d\d\b/);
      expect(text, path).not.toMatch(/\btransition-colors\b/);
    }
  });

  it('shows a Spinner only in buttons and polling rows', () => {
    const allowed = new Set(['ui/button.tsx', 'admin/templates/releases/try-sheet.tsx']);
    for (const { path, text } of files) {
      if (allowed.has(path)) continue;
      expect(text, path).not.toMatch(/<Spinner\b/);
    }
  });

  it('aligns kit rows with the row patterns, not margin hacks', () => {
    const rows = [
      'ui/list-row.tsx',
      'ui/inline-add-field.tsx',
      'ui/email-list.tsx',
      'ui/session-list.tsx',
    ];
    for (const { path, text } of files.filter((f) => rows.includes(f.path))) {
      expect(text, path).not.toMatch(/mt-\[/);
    }
  });

  // The sweep measures the element's own box, so a ::before hit area does not count.
  it('gives checkboxes, breadcrumbs and row links a real 44 px box on touch', () => {
    const text = (path: string) => files.find((f) => f.path === path)?.text ?? '';
    expect(text('ui/checkbox.tsx')).toContain('pointer-coarse:size-11');
    expect(text('ui/page-header.tsx')).toContain('pointer-coarse:min-h-11');
    expect(text('ui/row-link.tsx')).toContain('pointer-coarse:py-3');
    expect(text('ui/switch.tsx')).toContain('pointer-coarse:h-11');
    expect(text('ui/status-pill.tsx')).toContain('pointer-coarse:size-11');
  });

  // A segment that is off but open is a `hint` (hatched, quiet, with a tooltip): a lock icon in the
  // label crowds the row and stays on the chosen segment.
  it('marks an off segment with a hint, never a lock icon', () => {
    for (const { path, text } of files) {
      if (!text.includes('SegmentedControl')) continue;
      expect(text, path).not.toMatch(/icon:\s*Lock\b/);
    }
  });

  it('toasts only through the kit toast (ui/toaster.tsx, which loads ui/toaster-impl.tsx)', () => {
    for (const { path, text } of files) {
      if (path === 'ui/toaster-impl.tsx') continue;
      expect(text, path).not.toMatch(/from 'sonner'/);
    }
  });

  it('copies through CopyButton or copyText, never the clipboard directly', () => {
    // developers/shell/copy.ts: the portal's first load cannot carry React and the toaster.
    // workbench/playground/copy.ts: the page says "Copied" in place; the portal has no toaster.
    const allowed = new Set([
      'ui/copy-button.tsx',
      'lib/clipboard.ts',
      'developers/shell/copy.ts',
      'workbench/playground/copy.ts',
    ]);
    for (const { path, text } of files) {
      if (allowed.has(path)) continue;
      expect(text, path).not.toMatch(/navigator\.clipboard/);
    }
  });

  // One locale for dates and numbers: lib/format.ts. Zone math (ids, names, wall-clock offsets)
  // needs Intl too but formats nothing a person reads as a date or number; pass-card renders
  // the pass's own locale.
  it('formats dates and numbers only in lib/format.ts', () => {
    const allowed = new Set([
      'lib/format.ts',
      'lib/timezones.ts',
      'admin/passes/schema-form/datetime.ts',
    ]);
    for (const { path, text } of files) {
      if (allowed.has(path) || path.startsWith('pass-card/')) continue;
      expect(text, path).not.toMatch(/\bIntl\.|\.toLocale\w*\(/);
    }
  });

  // One status vocabulary on the Workbench: bench/status-chip.tsx (and bench/list.tsx's tick). A
  // tool draws no pill, no `*-code` or `*-status` class and no data-tone of its own.
  it('shows status on the Workbench tools only through the bench StatusChip', () => {
    // Every tool is on the bench: a file that breaks the rule goes on this list only while it moves.
    const pending = new Set<string>([]);
    const tools = /^workbench\/(console|webhooks|logs|keys|home)\//;
    const classes = /\bclass(?:Name)?[=:]\s*\{?\s*[`'"][^`'"]*\b(?:pill|[a-z]+-(?:code|status))\b/;
    for (const { path, text } of files) {
      if (!tools.test(path) || pending.has(path)) continue;
      expect(text, path).not.toMatch(classes);
      expect(text, path).not.toMatch(/\bdata-tone\b/);
    }
    // The list only shrinks: a file that no longer breaks the rule leaves it.
    for (const path of pending) {
      const text = files.find((f) => f.path === path)?.text ?? '';
      expect(classes.test(text) || /\bdata-tone\b/.test(text), path).toBe(true);
    }
  });

  // pass-card only spots addresses in pass text to break them; it validates nothing.
  it('checks emails with strictEmail (shared/email.ts), not a regex of its own', () => {
    for (const { path, text } of files) {
      if (path.startsWith('pass-card/')) continue;
      expect(text, path).not.toMatch(/\[\^\\s@\]\+@/);
    }
  });

  it('sinks only text fields when read-only (buttons match :read-only too)', () => {
    for (const { path, text } of files) {
      expect(text, path).not.toMatch(/(^|[\s'"`:])read-only:/);
    }
  });

  it('names the org scope in the path, not a search param, and never says Platform-wide', () => {
    // The scope gates strip a legacy ?orgId= with a middleware that only types it.
    const gates = new Set(['routes/admin/platform/route.tsx', 'routes/admin/o/$orgId/route.tsx']);
    for (const { path, text } of files) {
      if (!gates.has(path)) expect(text, path).not.toMatch(/\bsearch:[^\n]*\borgId\b/);
      expect(text, path).not.toMatch(/Platform-wide/);
    }
  });

  // L12 (Workbench v2 §2.3): Workbench pages reach tenant data only through the token client
  // (`useToolApi()`), never the admin session client or its Live/Test mode. The one exemption is
  // the tool scope, `lib/tool-api.tsx`, which the Workbench's host always pins. The check walks the
  // import graph (static and dynamic) from `workbench/**` and `routes/workbench/**`; the runtime
  // test in `workbench/shell/boundary.test.tsx` is the real guard.
  it('keeps the admin client and mode out of the Workbench', () => {
    const byPath = new Map(files.map((f) => [f.path, f.text]));
    const banned = new Set(['lib/api.ts', 'lib/mode.ts', 'lib/operations-client.ts']);
    // Modules that may touch the session on purpose: its own read (`useSession`), the account menu,
    // the tray body, whose session client is the admin default the Workbench replaces, and the lazy
    // error pages every route shares (their portal layout holds the holder's own client).
    const stop = new Set([
      'ui/layout/lazy-error-pages.tsx',
      'lib/tool-api.tsx',
      'lib/session.ts',
      'ui/layout/user-menu.tsx',
      'ui/layout/activity-tray-body.tsx',
    ]);
    const resolve = (from: string, spec: string): string | undefined => {
      const base = normalize(join(dirname(from), spec));
      return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find(
        (c) => byPath.has(c),
      );
    };
    const importsOf = (path: string): string[] =>
      [...(byPath.get(path) ?? '').matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]*)['"]/g)].flatMap(
        (m) => resolve(path, m[1] as string) ?? [],
      );
    const reached = (starts: string[]): string[] => {
      const seen = new Set(starts);
      const hits: string[] = [];
      const queue = [...starts];
      while (queue.length > 0) {
        const path = queue.shift() as string;
        for (const dep of importsOf(path)) {
          if (stop.has(dep)) continue;
          if (banned.has(dep)) hits.push(`${path} -> ${dep}`);
          else if (!seen.has(dep)) {
            seen.add(dep);
            queue.push(dep);
          }
        }
      }
      return hits;
    };
    const workbench = files
      .map((f) => f.path)
      .filter((p) => /^(workbench|routes\/workbench)\//.test(p) && !p.includes('test-fixtures'));
    expect(workbench.length).toBeGreaterThan(0);
    expect(reached(workbench)).toEqual([]);
    // The walk itself: the tray's session default and a direct import are both seen when not stopped.
    expect(reached(['ui/layout/activity-tray.tsx'])).toEqual([]);
    stop.delete('ui/layout/activity-tray-body.tsx');
    expect(reached(['ui/layout/activity-tray.tsx'])).toContain(
      'ui/layout/activity-tray-body.tsx -> lib/operations-client.ts',
    );
  });
});
