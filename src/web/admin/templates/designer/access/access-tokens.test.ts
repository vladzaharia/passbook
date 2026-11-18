import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Tailwind has no `border-border-subtle`; an unknown color class silently draws a black border.
describe('Access section classes', () => {
  it('use only colors the theme defines', () => {
    const dir = import.meta.dirname;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.tsx') && !f.includes('.test.')))
      expect(readFileSync(join(dir, file), 'utf8'), file).not.toContain('border-border-subtle');
  });
});
