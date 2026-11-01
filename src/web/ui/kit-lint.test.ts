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
    const allowed = new Set(['ui/button.tsx', 'ui/pending-note.tsx']);
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

  it('sinks only text fields when read-only (buttons match :read-only too)', () => {
    for (const { path, text } of files) {
      expect(text, path).not.toMatch(/(^|[\s'"`:])read-only:/);
    }
  });
});
