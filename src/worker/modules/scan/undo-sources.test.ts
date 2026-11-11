import { describe, expect, it } from 'vitest';

const sources = import.meta.glob(
  ['./undo*.ts', './repo-undo*.ts', './scan-undo-*.ts', '!./*.test.ts', '!./*-fixtures.ts'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

describe('undo sources', () => {
  it('finds the undo modules', () => {
    expect(Object.keys(sources).length).toBeGreaterThanOrEqual(5);
  });

  it('use no legacy actor authority, no revision stamps and no raw guarded writes', () => {
    for (const [file, text] of Object.entries(sources)) {
      expect(text, file).not.toMatch(/repo-actor-legacy-authority|repo-actor-authority/);
      expect(text, file).not.toMatch(/updated_at\s*=\s*\?/);
      expect(text, file).not.toMatch(
        /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:scans|scan_gates|scan_presence|pass_events)\b/i,
      );
    }
  });
});
