import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ID, changelogText, metadataYml } from './apps-fdroid.ts';

const root = join(import.meta.dirname, '..');

describe('F-Droid inputs', () => {
  it('declares the app id and the network anti-feature', () => {
    expect(readFileSync(join(root, 'android/app/build.gradle'), 'utf8')).toContain(
      `applicationId '${APP_ID}'`,
    );
    const yml = metadataYml();
    expect(yml).toContain('NonFreeNet:');
    expect(yml).toContain('SourceCode: https://github.com/vladzaharia/passbook');
    expect(yml).toContain('Name: "PassBook Reader"');
  });

  it('keeps whole bullets within the limit', () => {
    const notes = `# Title\n\n${Array.from({ length: 30 }, (_, i) => `- Change number ${i} with some words`).join('\n')}\n\nTrailing paragraph.`;
    const text = changelogText(notes);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(501);
    expect(text.startsWith('- Change number 0')).toBe(true);
    expect(text).not.toContain('Title');
    expect(text).not.toContain('Trailing');
    for (const line of text.trim().split('\n'))
      expect(line).toMatch(/^- Change number \d+ with some words$/);
  });

  it('reads the real release notes', () => {
    expect(
      changelogText(readFileSync(join(root, 'android/RELEASE-NOTES.md'), 'utf8')).length,
    ).toBeGreaterThan(0);
  });
});
