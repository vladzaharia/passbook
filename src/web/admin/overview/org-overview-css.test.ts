import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('org overview motion', () => {
  it('has no ambient loop', () => {
    const css = readFileSync(`${import.meta.dirname}/org-overview.css`, 'utf8');
    expect(css).not.toMatch(/infinite/);
  });
});
