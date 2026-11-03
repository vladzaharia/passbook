import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
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
    const allowed = new Set(['ui/button.tsx']);
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

  it('toasts only through the kit toast (ui/toaster.tsx)', () => {
    for (const { path, text } of files) {
      if (path === 'ui/toaster.tsx') continue;
      expect(text, path).not.toMatch(/from 'sonner'/);
    }
  });

  it('copies through CopyButton or copyText, never the clipboard directly', () => {
    const allowed = new Set(['ui/copy-button.tsx', 'lib/clipboard.ts']);
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
});
